import type { Config } from "@netlify/functions"
import { ApiError, fail, readJson } from "../lib/gemini.mts"
import { deleteAnnonce, listAnnonces, saveAnnonce, whoIs } from "../lib/store.mts"

// POST /api/historique { action: "liste" | "enregistrer" | "supprimer", annonce?, id? }
// Chaque vendeur ne voit que ses propres annonces. Ne consomme aucun crédit.
export default async (req: Request) => {
  try {
    const w = await whoIs(req)
    const b = await readJson(req)
    if (b.action === "liste") return Response.json({ annonces: await listAnnonces(w) })
    if (b.action === "enregistrer") {
      if (!b.annonce || typeof b.annonce !== "object") throw new ApiError("bad_request", "Annonce manquante.", 400)
      return Response.json({ annonce: await saveAnnonce(w, b.annonce) })
    }
    if (b.action === "supprimer") {
      await deleteAnnonce(w, String(b.id || ""))
      return Response.json({ ok: true })
    }
    throw new ApiError("bad_request", "Action inconnue.", 400)
  } catch (e) {
    return fail(e)
  }
}

export const config: Config = { path: "/api/historique", method: "POST" }
