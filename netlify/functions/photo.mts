import type { Config } from "@netlify/functions"
import { ApiError, IMAGE_MODEL, callGemini, fail, inlineImage, parts, readJson } from "../lib/gemini.mts"

// POST /api/photo
// { kind: "cintre"|"porte", vue: "face"|"dos", mannequin?: "femme"|"homme"|"fille"|"garcon",
//   taille?: string, type?: string, image: string (base64 JPEG) }
// → { mime: string, data: string (base64) }

const WHO: Record<string, string> = {
  femme: "une femme adulte",
  homme: "un homme adulte",
  fille: "une fille (enfant)",
  garcon: "un garçon (enfant)",
}

const FIDELITE =
  "Règles de fidélité strictes : garde exactement la couleur réelle, la matière, la coupe, le logo, " +
  "le texte imprimé et les étiquettes du vêtement, à l'identique. Ne retouche aucun logo ni aucune lettre. " +
  "Ne masque aucun défaut réel (tache, trou, bouloche, décoloration) : retire uniquement les plis et les froissés. " +
  "Fond uni de studio, d'une couleur douce assortie au vêtement, lumière douce et homogène, rendu photo réaliste, " +
  "cadrage vertical 4:5, vêtement entier visible, aucun texte ni filigrane ajouté."

function buildPrompt(b: any) {
  const quoi = b.type ? `(${String(b.type).slice(0, 120)})` : ""
  const taille = b.taille ? ` Taille indiquée sur l'étiquette : ${String(b.taille).slice(0, 40)}.` : ""
  if (b.kind === "cintre") {
    const vue = b.vue === "dos" ? "vu de dos" : "vu de face"
    return (
      `Voici la photo d'un vêtement de seconde main ${quoi} pour une annonce Vinted. ` +
      `Génère une photo de studio de ce même vêtement ${vue}, suspendu à un cintre en bois sur fond uni.` +
      taille + " " + FIDELITE
    )
  }
  if (b.kind === "porte") {
    const qui = WHO[b.mannequin] || WHO.femme
    return (
      `Voici la photo d'un vêtement de seconde main ${quoi} pour une annonce Vinted. ` +
      `Génère une photo de studio sur fond uni de ce même vêtement porté par ${qui}, ` +
      `à la morphologie qui correspond à la taille du vêtement.` + taille +
      " Pose naturelle et neutre, visage hors cadre ou peu visible, le vêtement est le sujet principal. " +
      FIDELITE
    )
  }
  throw new ApiError("bad_request", "Type de photo inconnu.", 400)
}

export default async (req: Request) => {
  try {
    const body = await readJson(req)
    const prompt = buildPrompt(body)

    const json = await callGemini(IMAGE_MODEL(), {
      contents: [{ role: "user", parts: [inlineImage(body.image), { text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    })

    const img = parts(json).find((p: any) => p.inlineData?.data || p.inline_data?.data)
    const d = img?.inlineData || img?.inline_data
    if (!d) {
      const reason = json?.candidates?.[0]?.finishReason
      throw new ApiError(reason && reason !== "STOP" ? "blocked" : "gemini", "Gemini n'a pas renvoyé d'image.", 502)
    }
    return Response.json({ mime: d.mimeType || d.mime_type || "image/png", data: d.data })
  } catch (e) {
    return fail(e)
  }
}

export const config: Config = { path: "/api/photo", method: "POST" }
