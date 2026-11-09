import type { Config } from "@netlify/functions"
import { ApiError, TEXT_MODEL, callGemini, fail, inlineImage, parts, readJson } from "../lib/gemini.mts"

// POST /api/analyse  { prompt: string, images: string[] (base64 JPEG) }
// → { result: object }  (the JSON the prompt asked Gemini for)
export default async (req: Request) => {
  try {
    const { prompt, images } = await readJson(req)
    if (typeof prompt !== "string" || !prompt.trim()) throw new ApiError("bad_request", "Consigne manquante.", 400)
    const imgs: string[] = Array.isArray(images) ? images.slice(0, 8) : []
    if (!imgs.length) throw new ApiError("bad_request", "Aucune photo reçue.", 400)

    const json = await callGemini(TEXT_MODEL(), {
      contents: [{ role: "user", parts: [...imgs.map((b) => inlineImage(b)), { text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
    })

    const text = parts(json).map((p: any) => p.text || "").join("").trim()
    let result: unknown
    try {
      result = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""))
    } catch {
      throw new ApiError("invalid_json", "La réponse de Gemini n'a pas pu être lue.", 502)
    }
    return Response.json({ result })
  } catch (e) {
    return fail(e)
  }
}

export const config: Config = { path: "/api/analyse", method: "POST" }
