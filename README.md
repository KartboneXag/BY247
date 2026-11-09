# Studio Fripe — By 247

Application web (installable sur téléphone) qui transforme quelques photos d'un vêtement en annonce Vinted : lecture de l'étiquette, titre, description honnête, et photos studio sur cintre et portées, générées par Gemini.

## Structure

```
public/                 site statique (index.html, icône, manifest, service worker)
netlify/functions/
  analyse.mts           POST /api/analyse — lecture d'étiquette + rédaction (Gemini texte)
  photo.mts             POST /api/photo   — photo studio cintre / portée (Gemini image)
netlify/lib/gemini.mts  appel Gemini, gestion des erreurs
netlify.toml            configuration Netlify
```

## Variables d'environnement (Netlify → Project configuration → Environment variables)

| Variable | Obligatoire | Rôle |
|---|---|---|
| `GEMINI_API_KEY` | oui | Clé API Google AI Studio (portée : Functions) |
| `ACCESS_CODE` | oui | Code d'accès demandé à l'ouverture de l'appli ; sans lui, l'API refuse tout |
| `GEMINI_TEXT_MODEL` | non | Modèle texte, défaut `gemini-2.5-flash` |
| `GEMINI_IMAGE_MODEL` | non | Modèle image, défaut `gemini-2.5-flash-image` |

Après avoir ajouté ou modifié une variable, relancer un déploiement.

## Développement local

```
npm install
npx netlify dev
```

## Règles de la maison

- La vraie photo reste toujours en premier ; les photos IA sont marquées « Studio IA ».
- On ne cache jamais un défaut et on ne change jamais la couleur réelle (consignes envoyées à Gemini).
