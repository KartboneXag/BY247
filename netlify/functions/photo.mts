import type { Config } from "@netlify/functions"
import { ApiError, IMAGE_MODEL, callGemini, fail, inlineImage, parts, readJson } from "../lib/gemini.mts"
import { refundPhotoCredit, takePhotoCredit, whoIs } from "../lib/store.mts"

// POST /api/photo
// { kind: "cintre"|"porte", vue: "face"|"dos", mannequin?: "femme"|"homme"|"fille"|"garcon",
//   taille?, type?, couleur?, matieres?: string, image: string (base64 JPEG, the real photo),
//   fix?: true, previous?: string (base64 JPEG, the AI photo to correct) }
// → { mime: string, data: string (base64), cost: number (estimated USD) }

const WHO: Record<string, string> = {
  femme: "une femme adulte",
  homme: "un homme adulte",
  fille: "une fille (enfant)",
  garcon: "un garçon (enfant)",
}

// Public Gemini API prices (USD per 1M tokens, paid tier) used to estimate each image's cost.
// Output images are billed as tokens (≈1,290 tokens per 1024px image for Flash Image).
const PRICES: Record<string, { in: number; out: number }> = {
  "gemini-3.1-flash-image": { in: 0.5, out: 60 },
  "gemini-2.5-flash-image": { in: 0.3, out: 30 },
  "gemini-3-pro-image": { in: 2, out: 120 },
}
function costUsd(model: string, usage: any) {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k)) || "gemini-3.1-flash-image"
  const p = PRICES[key]
  const inTok = Number(usage?.promptTokenCount) || 0
  const outTok = Number(usage?.candidatesTokenCount) || 1290
  return Math.round(((inTok * p.in + outTok * p.out) / 1e6) * 1e5) / 1e5
}

const clip = (v: unknown, n: number) => (v ? String(v).replace(/\s+/g, " ").trim().slice(0, n) : "")

// What must stay identical to the real photo, checked point by point.
const CHECKLIST =
  "Points à reproduire à l'identique, sans exception :\n" +
  "1. Couleur : même teinte exacte, même saturation, même luminosité que sur la photo réelle. Ne l'éclaircis pas, ne l'assombris pas, ne la rends pas plus vive.\n" +
  "2. Logos, imprimés et textes : même dessin, même taille, même position, mêmes couleurs ; chaque lettre recopiée exactement (orthographe, police, épaisseur). N'invente aucun texte, n'en supprime aucun.\n" +
  "3. Matière et texture : même tissu (maille, jean, lin, coton, laine, synthétique…), même grain, même brillance ou aspect mat.\n" +
  "4. Coupe et proportions : même longueur, même largeur, même forme du bas, même longueur et forme des manches.\n" +
  "5. Col, encolure, capuche : même forme, même taille, même finition (côtes, boutons, cordons).\n" +
  "6. Manches et poignets : mêmes coutures, mêmes revers ou bords-côtes, mêmes boutons.\n" +
  "7. Coutures et finitions : surpiqûres visibles, ourlets, empiècements, au même endroit et de la même couleur.\n" +
  "8. Boutons, fermetures, poches, rivets : même nombre, même forme, même couleur, même position.\n" +
  "9. Défauts réels (tache, trou, bouloche, décoloration) : conservés tels quels. Retire seulement les plis et les froissés.\n" +
  "N'ajoute rien (pas d'accessoire, de logo, de motif, de poche ou de bouton) et ne retire rien."

const STUDIO =
  "Mise en scène : fond uni de studio d'une couleur douce assortie au vêtement, lumière douce et homogène, " +
  "rendu photo réaliste, cadrage vertical 4:5, vêtement entier visible, aucun texte ni filigrane ajouté."

function context(b: any) {
  const lines = [
    clip(b.type, 120) && `Article : ${clip(b.type, 120)}.`,
    clip(b.couleur, 60) && `Couleur réelle relevée sur la photo : ${clip(b.couleur, 60)}.`,
    clip(b.matieres, 120) && `Matières (étiquette) : ${clip(b.matieres, 120)}.`,
    clip(b.taille, 40) && `Taille (étiquette) : ${clip(b.taille, 40)}.`,
  ].filter(Boolean)
  return lines.length ? lines.join(" ") + "\n" : ""
}

function scene(b: any) {
  if (b.kind === "cintre") {
    const vue = b.vue === "dos" ? "vu de dos" : "vu de face"
    return `Montre ce même vêtement ${vue}, suspendu bien droit à un cintre en bois, à plat, sans plis.`
  }
  if (b.kind === "porte") {
    const qui = WHO[b.mannequin] || WHO.femme
    return (
      `Montre ce même vêtement, vu de face, porté par ${qui} dont la morphologie correspond à la taille du vêtement. ` +
      "Pose naturelle et neutre, visage hors cadre ou peu visible ; le vêtement est le sujet principal et doit être entièrement visible."
    )
  }
  throw new ApiError("bad_request", "Type de photo inconnu.", 400)
}

function buildPrompt(b: any) {
  return (
    "Tu es retoucheur photo pour des annonces Vinted. La première image est la photo RÉELLE d'un vêtement de seconde main : " +
    "c'est la seule référence. Le résultat doit montrer CE vêtement précis, pas un vêtement similaire ni une version idéalisée.\n" +
    context(b) +
    scene(b) + "\n" + CHECKLIST + "\n" + STUDIO
  )
}

function buildFixPrompt(b: any) {
  return (
    "Tu es contrôleur qualité photo pour des annonces Vinted. La première image est la photo RÉELLE d'un vêtement (référence). " +
    "La deuxième image est une photo studio générée à partir d'elle, qui contient des erreurs de fidélité.\n" +
    context(b) +
    "Compare les deux images point par point (couleur, logos et typographie, matière, coupe, col, manches et poignets, coutures, " +
    "boutons et poches, défauts réels). Repère chaque différence, puis génère une NOUVELLE photo corrigée où le vêtement est " +
    "strictement identique à la photo réelle.\n" +
    scene(b) + "\n" + CHECKLIST + "\n" + STUDIO
  )
}

export default async (req: Request) => {
  try {
    const body = await readJson(req)
    const fix = body.fix === true
    if (fix && (typeof body.previous !== "string" || body.previous.length < 100)) {
      throw new ApiError("bad_request", "Photo à corriger manquante.", 400)
    }
    const prompt = fix ? buildFixPrompt(body) : buildPrompt(body)
    const images = fix ? [inlineImage(body.image), inlineImage(body.previous)] : [inlineImage(body.image)]

    // Une photo IA est payante : elle consomme un crédit photo, remboursé si Gemini échoue.
    const w = await whoIs(req)
    const restant = await takePhotoCredit(w)
    try {
      const model = IMAGE_MODEL()
      const json = await callGemini(model, {
        contents: [{ role: "user", parts: [...images, { text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"], temperature: 0.3 },
      })

      const img = parts(json).find((p: any) => p.inlineData?.data || p.inline_data?.data)
      const d = img?.inlineData || img?.inline_data
      if (!d) {
        const reason = json?.candidates?.[0]?.finishReason
        throw new ApiError(reason && reason !== "STOP" ? "blocked" : "gemini", "Gemini n'a pas renvoyé d'image.", 502)
      }
      return Response.json({ mime: d.mimeType || d.mime_type || "image/png", data: d.data, cost: costUsd(model, json?.usageMetadata), photosIA: restant })
    } catch (e) {
      await refundPhotoCredit(w)
      throw e
    }
  } catch (e) {
    return fail(e)
  }
}

export const config: Config = { path: "/api/photo", method: "POST" }
