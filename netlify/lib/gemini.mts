// Shared helpers for calling the Gemini API from Netlify Functions.
// The API key never leaves the server: it is read from the GEMINI_API_KEY env var.

const BASE = "https://generativelanguage.googleapis.com/v1beta/models"

export const TEXT_MODEL = () => Netlify.env.get("GEMINI_TEXT_MODEL") || "gemini-2.5-flash"
export const IMAGE_MODEL = () => Netlify.env.get("GEMINI_IMAGE_MODEL") || "gemini-2.5-flash-image"

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 500) {
    super(message)
  }
}

export function fail(e: unknown) {
  if (e instanceof ApiError) {
    return Response.json({ code: e.code, error: e.message }, { status: e.status })
  }
  console.error(e)
  return Response.json({ code: "server", error: "Erreur interne du serveur." }, { status: 500 })
}

// Access code: every API call must send the code set in the ACCESS_CODE env var
// (header x-access-code). Without ACCESS_CODE configured, the API stays closed.
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function checkAccess(req: Request) {
  const code = (Netlify.env.get("ACCESS_CODE") || "").trim()
  if (!code) throw new ApiError("no_code", "Le code d'accès n'est pas configuré sur le serveur.", 503)
  const sent = (req.headers.get("x-access-code") || "").trim()
  if (!sameText(sent.toLowerCase(), code.toLowerCase())) throw new ApiError("bad_code", "Code d'accès incorrect.", 401)
}

export async function readJson(req: Request) {
  if (req.method !== "POST") throw new ApiError("method", "Méthode non autorisée.", 405)
  checkAccess(req)
  try {
    return await req.json()
  } catch {
    throw new ApiError("bad_request", "Requête illisible.", 400)
  }
}

export function inlineImage(b64: string, mime = "image/jpeg") {
  if (typeof b64 !== "string" || b64.length < 100) throw new ApiError("bad_request", "Image manquante.", 400)
  return { inlineData: { mimeType: mime, data: b64 } }
}

export async function callGemini(model: string, body: unknown) {
  const key = Netlify.env.get("GEMINI_API_KEY")
  if (!key) throw new ApiError("no_key", "La clé Gemini n'est pas configurée sur le serveur.", 503)

  const res = await fetch(`${BASE}/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
  })
  const json: any = await res.json().catch(() => ({}))

  if (!res.ok) {
    const msg: string = json?.error?.message || `Gemini a répondu ${res.status}.`
    console.error("Gemini error", res.status, msg)
    if (res.status === 400 && /api key/i.test(msg)) throw new ApiError("bad_key", msg, 401)
    if (res.status === 401 || res.status === 403) throw new ApiError("bad_key", msg, 401)
    if (res.status === 429) {
      const code = /quota|billing/i.test(msg) ? "quota" : "rate_limited"
      throw new ApiError(code, msg, 429)
    }
    if (res.status === 404) throw new ApiError("model", `Modèle Gemini introuvable (${model}).`, 502)
    throw new ApiError("gemini", msg, 502)
  }

  if (json?.promptFeedback?.blockReason) {
    throw new ApiError("blocked", "Gemini a refusé cette demande.", 422)
  }
  return json
}

export function parts(json: any): any[] {
  return json?.candidates?.[0]?.content?.parts || []
}
