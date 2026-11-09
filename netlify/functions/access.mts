import type { Config } from "@netlify/functions"
import { fail } from "../lib/gemini.mts"
import { publicVendeur, whoIs } from "../lib/store.mts"

// POST /api/access  (en-tête x-access-code) → profil du vendeur : nom et crédits restants.
// Ne consomme rien : sert à l'écran d'accueil et à rafraîchir le compteur.
export default async (req: Request) => {
  try {
    return Response.json({ ok: true, ...publicVendeur(await whoIs(req)) })
  } catch (e) {
    return fail(e)
  }
}

export const config: Config = { path: "/api/access", method: "POST" }
