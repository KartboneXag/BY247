// Comptes vendeurs, crédits, tickets d'annonce et historique, stockés dans Netlify Blobs.
//
// Règle : un vendeur créé a 0 crédit. Sans crédit accordé par l'admin, il ne peut rien générer.
// - credits      : nombre d'annonces (lecture d'étiquette + rédaction + prix) qu'il peut lancer
// - photosIA     : nombre de photos studio IA (payantes chez Google) qu'il peut générer
// L'admin (code ADMIN_CODE) n'a pas de limite.
import { getStore } from "@netlify/blobs"
import { ApiError } from "./gemini.mts"

type Store = {
  get(key: string, opts?: any): Promise<any>
  getWithMetadata(key: string, opts?: any): Promise<any>
  setJSON(key: string, value: unknown, opts?: any): Promise<any>
  delete(key: string): Promise<any>
  list(opts?: any): Promise<{ blobs: { key: string; etag: string }[] }>
}

let testStore: Store | null = null
export function _useStoreForTests(s: Store | null) { testStore = s }
function db(): Store {
  return testStore || (getStore({ name: "studio-fripe", consistency: "strong" }) as unknown as Store)
}

export type Vendeur = {
  id: string          // empreinte du code (clé de stockage)
  code: string        // code à donner au vendeur
  nom: string
  credits: number
  photosIA: number
  annonces: number    // annonces lancées au total
  photosFaites: number
  cree: string
  dernier?: string
}
export type Who = { admin: true; id: "admin"; nom: string } | ({ admin: false } & Vendeur)

const TICKET_MS = 3 * 60 * 60 * 1000 // un ticket d'annonce vaut 3 h
const TICKET_CALLS = 8               // appels Gemini texte autorisés par annonce (étiquette, rédaction, prix, relances)

async function sha(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.trim().toUpperCase()))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)
}

function sameText(a: string, b: string) {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

export function newCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // sans 0/O/1/I pour éviter les confusions
  const r = crypto.getRandomValues(new Uint8Array(8))
  const s = [...r].map((x) => A[x % A.length]).join("")
  return `SF-${s.slice(0, 4)}-${s.slice(4)}`
}

/** Identifie l'appelant à partir de l'en-tête x-access-code. */
export async function whoIs(req: Request): Promise<Who> {
  const sent = (req.headers.get("x-access-code") || "").trim()
  if (!sent) throw new ApiError("bad_code", "Code d'accès manquant.", 401)
  const admin = (Netlify.env.get("ADMIN_CODE") || "").trim()
  if (admin && sameText(sent.toUpperCase(), admin.toUpperCase())) return { admin: true, id: "admin", nom: "Admin" }
  const v = (await db().get("vendeurs/" + (await sha(sent)), { type: "json" })) as Vendeur | null
  if (!v) throw new ApiError("bad_code", "Code d'accès incorrect.", 401)
  return { admin: false, ...v }
}

export async function requireAdmin(req: Request) {
  const w = await whoIs(req)
  if (!w.admin) throw new ApiError("forbidden", "Réservé à l'administrateur.", 403)
  return w
}

/** Lecture-modification-écriture protégée par etag (réessaie si deux écritures se croisent). */
async function update<T>(key: string, fn: (cur: T) => T): Promise<T> {
  for (let i = 0; i < 5; i++) {
    const e = await db().getWithMetadata(key, { type: "json" })
    if (!e) throw new ApiError("not_found", "Introuvable.", 404)
    const next = fn(e.data as T)
    const r = await db().setJSON(key, next, { onlyIfMatch: e.etag })
    if (r?.modified !== false) return next
  }
  throw new ApiError("busy", "Serveur occupé, réessayez.", 409)
}

export function publicVendeur(v: Vendeur | Who) {
  if ((v as Who).admin) return { admin: true, nom: "Admin", credits: null, photosIA: null }
  const x = v as Vendeur
  return { admin: false, nom: x.nom, credits: x.credits, photosIA: x.photosIA, annonces: x.annonces }
}

/* ---------- vendeurs (admin) ---------- */
export async function createVendeur(nom: string) {
  const code = newCode()
  const id = await sha(code)
  const v: Vendeur = { id, code, nom: nom.slice(0, 60) || "Vendeur", credits: 0, photosIA: 0, annonces: 0, photosFaites: 0, cree: new Date().toISOString() }
  await db().setJSON("vendeurs/" + id, v, { onlyIfNew: true })
  return v
}

export async function listVendeurs(): Promise<Vendeur[]> {
  const { blobs } = await db().list({ prefix: "vendeurs/" })
  const all = await Promise.all(blobs.map((b) => db().get(b.key, { type: "json" })))
  return (all.filter(Boolean) as Vendeur[]).sort((a, b) => a.cree.localeCompare(b.cree))
}

export async function setVendeur(id: string, patch: { credits?: number; photosIA?: number; nom?: string; addCredits?: number; addPhotos?: number }) {
  const n = (x: unknown) => Math.max(0, Math.min(10000, Math.floor(Number(x) || 0)))
  return update<Vendeur>("vendeurs/" + id, (v) => ({
    ...v,
    nom: typeof patch.nom === "string" && patch.nom.trim() ? patch.nom.trim().slice(0, 60) : v.nom,
    credits: patch.credits != null ? n(patch.credits) : n(v.credits + (Number(patch.addCredits) || 0)),
    photosIA: patch.photosIA != null ? n(patch.photosIA) : n(v.photosIA + (Number(patch.addPhotos) || 0)),
  }))
}

export async function deleteVendeur(id: string) {
  await db().delete("vendeurs/" + id)
}

/* ---------- tickets d'annonce ---------- */
type Ticket = { id: string; vendeur: string; exp: number; calls: number }

/** Démarre une annonce : consomme 1 crédit et renvoie un ticket. */
export async function startAnnonce(w: Who) {
  let restant: number | null = null
  if (!w.admin) {
    const v = await update<Vendeur>("vendeurs/" + w.id, (cur) => {
      if (cur.credits <= 0) throw new ApiError("no_credit", "Plus d'annonce disponible. Demandez des crédits à l'administrateur.", 402)
      return { ...cur, credits: cur.credits - 1, annonces: cur.annonces + 1, dernier: new Date().toISOString() }
    })
    restant = v.credits
  }
  const t: Ticket = { id: crypto.randomUUID(), vendeur: w.id, exp: Date.now() + TICKET_MS, calls: 0 }
  await db().setJSON("tickets/" + t.id, t)
  return { ticket: t.id, credits: restant }
}

/** Vérifie le ticket envoyé (en-tête x-ticket) et compte un appel Gemini texte. */
export async function useTicket(req: Request, w: Who) {
  const id = (req.headers.get("x-ticket") || "").trim()
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError("no_ticket", "Lancez d'abord une annonce.", 402)
  await update<Ticket>("tickets/" + id, (t) => {
    if (t.vendeur !== w.id) throw new ApiError("no_ticket", "Ticket invalide.", 403)
    if (t.exp < Date.now()) throw new ApiError("no_ticket", "Annonce expirée : relancez-en une nouvelle.", 402)
    if (t.calls >= TICKET_CALLS) throw new ApiError("no_ticket", "Trop de relances pour cette annonce.", 429)
    return { ...t, calls: t.calls + 1 }
  }).catch((e) => {
    if (e instanceof ApiError && e.code === "not_found") throw new ApiError("no_ticket", "Ticket inconnu.", 402)
    throw e
  })
}

/* ---------- photos IA ---------- */
export async function takePhotoCredit(w: Who) {
  if (w.admin) return null
  const v = await update<Vendeur>("vendeurs/" + w.id, (cur) => {
    if (cur.photosIA <= 0) throw new ApiError("no_photo_credit", "Plus de photo studio IA disponible. Demandez-en à l'administrateur.", 402)
    return { ...cur, photosIA: cur.photosIA - 1, photosFaites: cur.photosFaites + 1 }
  })
  return v.photosIA
}
export async function refundPhotoCredit(w: Who) {
  if (w.admin) return
  await update<Vendeur>("vendeurs/" + w.id, (cur) => ({ ...cur, photosIA: cur.photosIA + 1, photosFaites: Math.max(0, cur.photosFaites - 1) })).catch(() => {})
}

/* ---------- demandes de crédits ---------- */
export type Demande = { id: string; vendeur: string; nom: string; message: string; date: string; annonces: number; photos: number }
export async function addDemande(w: Who, message: string, annonces: number, photos: number) {
  if (w.admin) throw new ApiError("bad_request", "L'admin n'a pas besoin de demander.", 400)
  const d: Demande = {
    id: Date.now() + "-" + crypto.randomUUID().slice(0, 6), vendeur: w.id, nom: w.nom,
    message: String(message || "").slice(0, 300), date: new Date().toISOString(),
    annonces: Math.max(0, Math.min(500, Math.floor(Number(annonces) || 0))),
    photos: Math.max(0, Math.min(500, Math.floor(Number(photos) || 0))),
  }
  await db().setJSON("demandes/" + d.id, d)
  return d
}
export async function listDemandes(): Promise<Demande[]> {
  const { blobs } = await db().list({ prefix: "demandes/" })
  const all = await Promise.all(blobs.map((b) => db().get(b.key, { type: "json" })))
  return (all.filter(Boolean) as Demande[]).sort((a, b) => b.date.localeCompare(a.date))
}
export async function deleteDemande(id: string) {
  await db().delete("demandes/" + id.replace(/[^0-9a-z-]/gi, ""))
}

/* ---------- historique ---------- */
export type Annonce = {
  id: string; date: string; maj: string
  statut: "brouillon" | "en_ligne" | "vendu"
  titre: string; description: string; marque: string | null; taille: string | null
  categorie: string | null; etat: string | null; couleur: string | null; matieres: string | null
  prix_conseille: number | null; prix_plancher: number | null; prix_vendu: number | null
  vignette: string | null // petite image JPEG en data URL
}
const hKey = (w: Who, id: string) => `annonces/${w.id}/${id.replace(/[^0-9a-z-]/gi, "")}`

export async function listAnnonces(w: Who, vendeurId?: string): Promise<Annonce[]> {
  const owner = w.admin && vendeurId ? vendeurId : w.id
  const { blobs } = await db().list({ prefix: `annonces/${owner}/` })
  const all = await Promise.all(blobs.map((b) => db().get(b.key, { type: "json" })))
  return (all.filter(Boolean) as Annonce[]).sort((a, b) => b.date.localeCompare(a.date))
}

export async function saveAnnonce(w: Who, a: Partial<Annonce>) {
  const txt = (v: unknown, n: number) => (v == null || v === "" ? null : String(v).slice(0, n))
  const num = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v) * 100) / 100))
  const id = a.id && /^[0-9a-z-]{8,64}$/i.test(a.id) ? a.id : crypto.randomUUID()
  const prev = (await db().get(hKey(w, id), { type: "json" })) as Annonce | null
  const vignette = typeof a.vignette === "string" && a.vignette.startsWith("data:image/") && a.vignette.length < 120_000 ? a.vignette : prev?.vignette ?? null
  const now = new Date().toISOString()
  const out: Annonce = {
    id, date: prev?.date || now, maj: now,
    statut: (["brouillon", "en_ligne", "vendu"] as const).includes(a.statut as any) ? (a.statut as Annonce["statut"]) : prev?.statut || "brouillon",
    titre: txt(a.titre, 120) || prev?.titre || "Annonce", description: txt(a.description, 3000) ?? prev?.description ?? "",
    marque: txt(a.marque, 80) ?? prev?.marque ?? null, taille: txt(a.taille, 60) ?? prev?.taille ?? null,
    categorie: txt(a.categorie, 120) ?? prev?.categorie ?? null, etat: txt(a.etat, 40) ?? prev?.etat ?? null,
    couleur: txt(a.couleur, 60) ?? prev?.couleur ?? null, matieres: txt(a.matieres, 200) ?? prev?.matieres ?? null,
    prix_conseille: a.prix_conseille !== undefined ? num(a.prix_conseille) : prev?.prix_conseille ?? null,
    prix_plancher: a.prix_plancher !== undefined ? num(a.prix_plancher) : prev?.prix_plancher ?? null,
    prix_vendu: a.prix_vendu !== undefined ? num(a.prix_vendu) : prev?.prix_vendu ?? null,
    vignette,
  }
  await db().setJSON(hKey(w, id), out)
  return out
}

export async function deleteAnnonce(w: Who, id: string) {
  await db().delete(hKey(w, id))
}
