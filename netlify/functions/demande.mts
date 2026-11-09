import type { Config } from "@netlify/functions"
import { fail, readJson } from "../lib/gemini.mts"
import { addDemande, whoIs } from "../lib/store.mts"

// POST /api/demande { annonces, photos, message } → le vendeur demande des crédits à l'admin.
export default async (req: Request) => {
  try {
    const w = await whoIs(req)
    const b = await readJson(req)
    const d = await addDemande(w, b.message, b.annonces, b.photos)
    return Response.json({ ok: true, id: d.id })
  } catch (e) {
    return fail(e)
  }
}

export const config: Config = { path: "/api/demande", method: "POST" }
