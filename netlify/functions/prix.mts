import type { Config } from "@netlify/functions"
import { ApiError, TEXT_MODEL, callGemini, fail, parts, readJson } from "../lib/gemini.mts"
import { useTicket, whoIs } from "../lib/store.mts"

// POST /api/prix { titre, marque, type, taille, etat, matieres } (+ x-ticket)
// Gemini cherche sur le web (Google Search) les prix d'articles comparables d'occasion
// et renvoie { prix_conseille, prix_plancher, prix_haut, explication, comparables, sources, web }.
const clip = (v: unknown, n: number) => (v ? String(v).replace(/\s+/g, " ").trim().slice(0, n) : "")

function prompt(b: any) {
  const art = [clip(b.type, 80), clip(b.marque, 60) && `de la marque ${clip(b.marque, 60)}`, clip(b.taille, 30) && `taille ${clip(b.taille, 30)}`]
    .filter(Boolean).join(", ")
  return (
    `Tu aides un vendeur français à fixer le prix d'un vêtement de seconde main sur Vinted.\n` +
    `Article : ${clip(b.titre, 120) || art}. ${art ? "Détails : " + art + "." : ""} ` +
    `État : ${clip(b.etat, 40) || "inconnu"}. ${clip(b.matieres, 120) ? "Matières : " + clip(b.matieres, 120) + "." : ""}\n` +
    `Cherche sur le web les prix d'articles identiques ou très proches, d'occasion, en France (Vinted, Leboncoin, Vestiaire Collective, eBay.fr), ` +
    `et le prix neuf si tu le trouves. Ignore les annonces sans prix.\n` +
    `Déduis-en :\n` +
    `- prix_conseille : le prix d'affichage réaliste pour vendre en moins de 2 semaines ;\n` +
    `- prix_plancher : le prix minimum en dessous duquel il ne faut pas accepter d'offre ;\n` +
    `- prix_haut : le prix maximum raisonnable.\n` +
    `Prix en euros, nombres entiers. N'invente aucun prix : si tu ne trouves rien de comparable, estime à partir de la marque et de l'état et dis-le dans l'explication.\n` +
    `Réponds UNIQUEMENT avec ce JSON, sans texte autour :\n` +
    `{"prix_conseille":number,"prix_plancher":number,"prix_haut":number,"prix_neuf":number|null,"explication":string,"comparables":[{"source":string,"prix":number,"description":string}]}`
  )
}

function parse(text: string) {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new ApiError("invalid_json", "La recherche de prix n'a pas pu être lue.", 502)
  return JSON.parse(m[0])
}

const euro = (v: unknown) => (isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null)

export default async (req: Request) => {
  try {
    const b = await readJson(req)
    await useTicket(req, await whoIs(req))
    if (!clip(b.titre, 120) && !clip(b.type, 80)) throw new ApiError("bad_request", "Article à estimer manquant.", 400)

    let json: any
    let web = true
    try {
      json = await callGemini(TEXT_MODEL(), {
        contents: [{ role: "user", parts: [{ text: prompt(b) }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2 },
      })
    } catch (e) {
      // Si la recherche web n'est pas disponible sur le compte, on estime sans elle (et on le signale).
      if (!(e instanceof ApiError) || !["gemini", "quota", "rate_limited"].includes(e.code)) throw e
      web = false
      json = await callGemini(TEXT_MODEL(), {
        contents: [{ role: "user", parts: [{ text: prompt(b) + "\n(Recherche web indisponible : estime d'après tes connaissances.)" }] }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      })
    }

    const r = parse(parts(json).map((p: any) => p.text || "").join(""))
    let conseille = euro(r.prix_conseille)
    let plancher = euro(r.prix_plancher)
    const haut = euro(r.prix_haut)
    if (conseille && plancher && plancher > conseille) [plancher, conseille] = [conseille, plancher]

    const chunks: any[] = json?.candidates?.[0]?.groundingMetadata?.groundingChunks || []
    const sources = chunks
      .map((c) => c?.web)
      .filter((w) => w?.uri)
      .slice(0, 6)
      .map((w) => ({ titre: clip(w.title, 80) || "Source", url: String(w.uri) }))

    return Response.json({
      prix_conseille: conseille,
      prix_plancher: plancher,
      prix_haut: haut,
      prix_neuf: euro(r.prix_neuf),
      explication: clip(r.explication, 400),
      comparables: (Array.isArray(r.comparables) ? r.comparables : []).slice(0, 5).map((c: any) => ({
        source: clip(c?.source, 40), prix: euro(c?.prix), description: clip(c?.description, 100),
      })),
      sources,
      web: web && sources.length > 0,
    })
  } catch (e) {
    return fail(e)
  }
}

export const config: Config = { path: "/api/prix", method: "POST" }
