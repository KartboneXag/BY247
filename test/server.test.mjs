// Tests du serveur : faux stockage Blobs en mémoire + faux Gemini. Aucun appel réseau.
import assert from "node:assert/strict"

const env = { GEMINI_API_KEY: "k", ADMIN_CODE: "patron-247" }
globalThis.Netlify = { env: { get: (k) => env[k] } }

// --- faux Blobs : clés, etags, onlyIfNew / onlyIfMatch ---
const mem = new Map()
let n = 0
const store = {
  async get(k) { return mem.has(k) ? structuredClone(mem.get(k).v) : null },
  async getWithMetadata(k) { return mem.has(k) ? { data: structuredClone(mem.get(k).v), etag: mem.get(k).e } : null },
  async setJSON(k, v, o = {}) {
    if (o.onlyIfNew && mem.has(k)) return { modified: false }
    if (o.onlyIfMatch && mem.get(k)?.e !== o.onlyIfMatch) return { modified: false }
    mem.set(k, { v: structuredClone(v), e: "e" + ++n }); return { modified: true }
  },
  async delete(k) { mem.delete(k) },
  async list({ prefix = "" } = {}) { return { blobs: [...mem.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, etag: "" })) } },
}
const { _useStoreForTests } = await import("../netlify/lib/store.mts")
_useStoreForTests(store)

// --- faux Gemini ---
let calls = []
let reply = () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] })
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body); calls.push({ url, body })
  const r = reply(body)
  return { ok: !r.status, status: r.status || 200, json: async () => r.json || r }
}

const fn = async (name) => (await import(`../netlify/functions/${name}.mts`)).default
const [access, annonce, analyse, photo, prix, historique, demande, admin] = await Promise.all(
  ["access", "annonce", "analyse", "photo", "prix", "historique", "demande", "admin"].map(fn))
const call = async (f, body, code, ticket) => {
  const h = { "content-type": "application/json" }
  if (code) h["x-access-code"] = code
  if (ticket) h["x-ticket"] = ticket
  const r = await f(new Request("http://x/api", { method: "POST", headers: h, body: JSON.stringify(body || {}) }))
  return { status: r.status, body: await r.json() }
}
const IMG = "A".repeat(200)

// 1. Sans code / mauvais code
assert.equal((await call(access, {}, null)).status, 401)
assert.equal((await call(access, {}, "nimporte")).status, 401)
console.log("✓ sans code valide : refusé")

// 2. Admin crée un vendeur → 0 crédit
let r = await call(admin, { action: "creer", nom: "Julie" }, "PATRON-247")
assert.equal(r.status, 200)
const julie = r.body.vendeur
assert.match(julie.code, /^SF-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
assert.equal(julie.credits, 0); assert.equal(julie.photosIA, 0)
r = await call(access, {}, julie.code.toLowerCase())
assert.deepEqual([r.status, r.body.nom, r.body.credits], [200, "Julie", 0])
console.log("✓ vendeur créé avec 0 annonce, son code fonctionne (insensible à la casse)")

// 3. Un vendeur ne peut pas utiliser l'admin
assert.equal((await call(admin, { action: "etat" }, julie.code)).status, 403)
console.log("✓ un vendeur n'accède pas à l'admin")

// 4. À 0 crédit : impossible de lancer une annonce, ni d'appeler Gemini, ni une photo IA
calls = []
r = await call(annonce, {}, julie.code)
assert.deepEqual([r.status, r.body.code], [402, "no_credit"])
r = await call(analyse, { prompt: "x", images: [IMG] }, julie.code)
assert.deepEqual([r.status, r.body.code], [402, "no_ticket"])
r = await call(photo, { kind: "cintre", vue: "face", image: IMG }, julie.code)
assert.deepEqual([r.status, r.body.code], [402, "no_photo_credit"])
assert.equal(calls.length, 0, "aucun appel Gemini ne doit partir")
console.log("✓ à 0 crédit : rien ne part chez Gemini (annonce, analyse, photo IA)")

// 5. Demande de crédits → visible par l'admin → accordée
r = await call(demande, { annonces: 10, photos: 3, message: "Pour le vide-dressing" }, julie.code)
assert.equal(r.status, 200)
r = await call(admin, { action: "etat" }, "patron-247")
assert.equal(r.body.demandes.length, 1)
const dem = r.body.demandes[0]
assert.deepEqual([dem.nom, dem.annonces, dem.photos], ["Julie", 10, 3])
r = await call(admin, { action: "accorder", id: julie.id, demande: dem.id, addCredits: 2, addPhotos: 1 }, "patron-247")
assert.deepEqual([r.body.vendeur.credits, r.body.vendeur.photosIA], [2, 1])
assert.equal((await call(admin, { action: "etat" }, "patron-247")).body.demandes.length, 0)
console.log("✓ demande de crédits → l'admin accorde 2 annonces + 1 photo IA")

// 6. Lancer une annonce consomme 1 crédit ; le ticket ouvre analyse et prix
r = await call(annonce, {}, julie.code)
assert.deepEqual([r.status, r.body.credits], [200, 1])
const ticket = r.body.ticket
r = await call(analyse, { prompt: "lis", images: [IMG] }, julie.code, ticket)
assert.deepEqual([r.status, r.body.result], [200, { ok: true }])
assert.match(calls.at(-1).url, /gemini-3\.6-flash:generateContent/)
console.log("✓ annonce lancée : 1 crédit consommé, analyse autorisée (modèle gemini-3.6-flash)")

// 7. Le ticket d'un autre vendeur est refusé
const marc = (await call(admin, { action: "creer", nom: "Marc" }, "patron-247")).body.vendeur
r = await call(analyse, { prompt: "lis", images: [IMG] }, marc.code, ticket)
assert.equal(r.status, 403)
console.log("✓ ticket non transférable entre vendeurs")

// 8. Prix avec recherche web : prix + sources, plancher ≤ conseillé
reply = (b) => {
  assert.deepEqual(b.tools, [{ google_search: {} }])
  return { candidates: [{ content: { parts: [{ text: 'Voici :\n```json\n{"prix_conseille":18,"prix_plancher":25,"prix_haut":30,"prix_neuf":89,"explication":"3 annonces proches entre 15 et 30 €","comparables":[{"source":"Vinted","prix":20,"description":"même modèle, M"}]}\n```' }] },
    groundingMetadata: { groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/x", title: "vinted.fr" } }] } }] }
}
r = await call(prix, { titre: "Pull Sézane bleu M", marque: "Sézane", etat: "Très bon état" }, julie.code, ticket)
assert.equal(r.status, 200)
assert.deepEqual([r.body.prix_conseille, r.body.prix_plancher, r.body.web], [25, 18, true])
assert.equal(r.body.sources[0].titre, "vinted.fr")
assert.match(calls.at(-1).body.contents[0].parts[0].text, /Sézane/)
console.log("✓ prix : recherche Google activée, plancher/conseillé remis dans l'ordre, sources renvoyées")

// 9. Si la recherche web échoue → estimation sans web, signalée
let first = true
reply = (b) => {
  if (b.tools && first) { first = false; return { status: 400, json: { error: { message: "Search grounding is not supported" } } } }
  return { candidates: [{ content: { parts: [{ text: '{"prix_conseille":15,"prix_plancher":10,"prix_haut":20,"explication":"estimation"}' }] } }] }
}
r = await call(prix, { titre: "Pull" }, julie.code, ticket)
assert.deepEqual([r.status, r.body.web, r.body.prix_plancher], [200, false, 10])
console.log("✓ prix : repli sans recherche web si indisponible, et signalé")

// 10. Photo IA : consomme 1 crédit photo ; remboursé si Gemini échoue
reply = () => ({ status: 429, json: { error: { message: "quota billing" } } })
r = await call(photo, { kind: "cintre", vue: "face", image: IMG }, julie.code)
assert.equal(r.status, 429)
r = await call(access, {}, julie.code); assert.equal(r.body.photosIA, 1)
reply = () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "iVBOR" } }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1120 } })
r = await call(photo, { kind: "cintre", vue: "face", image: IMG }, julie.code)
assert.deepEqual([r.status, r.body.photosIA], [200, 0])
assert.match(calls.at(-1).url, /gemini-3\.1-flash-image/)
assert.ok(r.body.cost > 0.06 && r.body.cost < 0.08, "coût estimé ≈ 0,067 $")
r = await call(photo, { kind: "cintre", vue: "face", image: IMG }, julie.code)
assert.equal(r.body.code, "no_photo_credit")
console.log("✓ photo IA : crédit remboursé en cas d'échec, consommé en cas de succès, puis bloqué")

// 11. Historique : chacun ne voit que le sien ; statut et prix de vente
r = await call(historique, { action: "enregistrer", annonce: { titre: "Pull Sézane", marque: "Sézane", prix_plancher: 18, vignette: "data:image/jpeg;base64,xx" } }, julie.code)
const a = r.body.annonce
assert.deepEqual([a.statut, a.marque, a.prix_plancher], ["brouillon", "Sézane", 18])
r = await call(historique, { action: "enregistrer", annonce: { id: a.id, statut: "vendu", prix_vendu: 22 } }, julie.code)
assert.deepEqual([r.body.annonce.statut, r.body.annonce.prix_vendu, r.body.annonce.titre], ["vendu", 22, "Pull Sézane"])
assert.equal((await call(historique, { action: "liste" }, julie.code)).body.annonces.length, 1)
assert.equal((await call(historique, { action: "liste" }, marc.code)).body.annonces.length, 0)
assert.equal((await call(admin, { action: "annonces", id: julie.id }, "patron-247")).body.annonces.length, 1)
await call(historique, { action: "supprimer", id: a.id }, julie.code)
assert.equal((await call(historique, { action: "liste" }, julie.code)).body.annonces.length, 0)
console.log("✓ historique : privé par vendeur, statut vendu + prix, visible par l'admin, suppression")

// 12. L'admin n'a pas de limite
r = await call(annonce, {}, "patron-247")
assert.deepEqual([r.status, r.body.credits], [200, null])
console.log("✓ admin : annonces sans limite")

// 13. Dernier crédit, puis blocage
await call(annonce, {}, julie.code)
r = await call(annonce, {}, julie.code)
assert.equal(r.body.code, "no_credit")
console.log("✓ crédits épuisés : de nouveau bloqué")

// 14. Vendeur illimité défini côté serveur (empreinte dans VENDEURS_ILLIMITES)
const OWNER = "SF-TEST-ILLI-MITE-0001"
const h = (await import("node:crypto")).createHash("sha256").update(OWNER).digest("hex").slice(0, 32)
env.VENDEURS_ILLIMITES = `${h}=noircime@gmail.com`
r = await call(access, {}, OWNER.toLowerCase())
assert.deepEqual([r.status, r.body.illimite, r.body.nom, r.body.credits], [200, true, "noircime@gmail.com", null])
for (let i = 0; i < 3; i++) assert.equal((await call(annonce, {}, OWNER)).status, 200)
reply = () => ({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "x" } }] } }] })
assert.equal((await call(photo, { kind: "cintre", vue: "face", image: IMG }, OWNER)).status, 200)
let st = await call(admin, { action: "etat" }, "patron-247")
let me = st.body.vendeurs.find((v) => v.id === h)
assert.deepEqual([me.illimite, me.credits, me.annonces, me.photosFaites, me.code], [true, 0, 3, 1, "privé"])
// l'admin web ne peut pas retirer l'illimité, et le navigateur ne peut pas se l'accorder
await call(admin, { action: "crediter", id: h, illimite: false, credits: 0 }, "patron-247")
assert.equal((await call(access, {}, OWNER)).body.illimite, true)
await call(admin, { action: "crediter", id: marc.id, illimite: true }, "patron-247")
assert.equal((await call(access, {}, marc.code)).body.illimite, false)
assert.equal((await call(annonce, {}, marc.code)).body.code, "no_credit")
// retiré de la variable serveur → redevient un vendeur normal à 0
env.VENDEURS_ILLIMITES = ""
assert.equal((await call(annonce, {}, OWNER)).body.code, "no_credit")
console.log("✓ illimité : fixé côté serveur, jamais décompté, stats suivies, non modifiable via l'admin ou le navigateur")

console.log("\nTous les tests serveur passent.")
