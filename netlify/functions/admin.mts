import type { Config } from "@netlify/functions"
import { ApiError, fail, readJson } from "../lib/gemini.mts"
import {
  createVendeur, deleteDemande, deleteVendeur, listAnnonces, listDemandes, listVendeurs, requireAdmin, setVendeur,
} from "../lib/store.mts"

// POST /api/admin { action, ... } — réservé au code ADMIN_CODE.
//   etat                                  → { vendeurs, demandes }
//   creer      { nom }                    → vendeur créé avec 0 crédit
//   crediter   { id, addCredits?, addPhotos?, credits?, photosIA?, nom? }
//   supprimer  { id }
//   accorder   { demande, id, addCredits, addPhotos } → crédite puis archive la demande
//   refuser    { demande }
//   annonces   { id }                     → historique d'un vendeur
export default async (req: Request) => {
  try {
    const w = await requireAdmin(req)
    const b = await readJson(req)
    const id = typeof b.id === "string" ? b.id.replace(/[^0-9a-f]/gi, "") : ""
    switch (b.action) {
      case "etat":
        return Response.json({ vendeurs: await listVendeurs(), demandes: await listDemandes() })
      case "creer":
        return Response.json({ vendeur: await createVendeur(String(b.nom || "").trim()) })
      case "crediter":
        if (!id) throw new ApiError("bad_request", "Vendeur manquant.", 400)
        return Response.json({ vendeur: await setVendeur(id, b) })
      case "supprimer":
        if (!id) throw new ApiError("bad_request", "Vendeur manquant.", 400)
        await deleteVendeur(id)
        return Response.json({ ok: true })
      case "accorder": {
        if (!id) throw new ApiError("bad_request", "Vendeur manquant.", 400)
        const v = await setVendeur(id, { addCredits: b.addCredits, addPhotos: b.addPhotos })
        if (b.demande) await deleteDemande(String(b.demande))
        return Response.json({ vendeur: v })
      }
      case "refuser":
        await deleteDemande(String(b.demande || ""))
        return Response.json({ ok: true })
      case "annonces":
        return Response.json({ annonces: await listAnnonces(w, id) })
      default:
        throw new ApiError("bad_request", "Action inconnue.", 400)
    }
  } catch (e) {
    return fail(e)
  }
}

export const config: Config = { path: "/api/admin", method: "POST" }
