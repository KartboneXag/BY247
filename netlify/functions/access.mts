import type { Config } from "@netlify/functions"
import { checkAccess, fail } from "../lib/gemini.mts"

// POST /api/access  (header x-access-code) → { ok: true } if the code is right.
// Lets the app check the code on the welcome screen without calling Gemini.
export default async (req: Request) => {
  try {
    checkAccess(req)
    return Response.json({ ok: true })
  } catch (e) {
    return fail(e)
  }
}

export const config: Config = { path: "/api/access", method: "POST" }
