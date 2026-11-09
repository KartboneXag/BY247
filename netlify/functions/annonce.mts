import type { Config } from "@netlify/functions"
import { fail } from "../lib/gemini.mts"
import { startAnnonce, whoIs } from "../lib/store.mts"

// POST /api/annonce → consomme 1 crédit et renvoie { ticket, credits }.
// Le ticket est ensuite exigé par /api/analyse et /api/prix (en-tête x-ticket).
export default async (req: Request) => {
  try {
    return Response.json(await startAnnonce(await whoIs(req)))
  } catch (e) {
    return fail(e)
  }
}

export const config: Config = { path: "/api/annonce", method: "POST" }
