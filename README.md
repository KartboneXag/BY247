# Studio Fripe — By 247

Application web (installable sur téléphone) qui transforme quelques photos d'un vêtement en annonce Vinted : lecture de l'étiquette, titre et description avec la marque, prix conseillé et prix plancher cherchés sur le web, photos studio, historique des annonces et mode lot.

## Accès et crédits
- Chaque vendeur a son **code** (ex. `SF-ABCD-EFGH`), créé dans **/admin.html**. Un vendeur créé a **0 annonce et 0 photo IA** : il ne peut rien générer tant que l'admin ne lui accorde pas de crédits.
- 1 annonce = 1 crédit (lecture d'étiquette + rédaction + recherche de prix). 1 photo studio IA = 1 crédit photo (remboursé si Gemini échoue).
- Le vendeur peut **demander des crédits** depuis l'appli ; les demandes apparaissent dans /admin.html.
- Le code `ADMIN_CODE` donne accès à /admin.html et utilise l'appli sans limite.

## Structure
```
public/index.html            appli (photos, contrôle photo, mode lot, annonce, prix, historique)
public/admin.html            gestion des vendeurs, crédits et demandes
netlify/functions/
  access.mts      POST /api/access      profil + crédits restants
  annonce.mts     POST /api/annonce     consomme 1 crédit → ticket d'annonce
  analyse.mts     POST /api/analyse     Gemini texte (exige le ticket)
  prix.mts        POST /api/prix        prix conseillé / plancher via Google Search (exige le ticket)
  photo.mts       POST /api/photo       photo studio IA (exige un crédit photo)
  historique.mts  POST /api/historique  annonces du vendeur (liste, enregistrer, supprimer)
  demande.mts     POST /api/demande     demande de crédits
  admin.mts       POST /api/admin       réservé à ADMIN_CODE
netlify/lib/gemini.mts       appel Gemini
netlify/lib/store.mts        vendeurs, crédits, tickets, historique (Netlify Blobs)
test/server.test.mjs         tests avec stockage et Gemini simulés : npm test
```

## Variables d'environnement (Netlify → Project configuration → Environment variables)
| Variable | Obligatoire | Rôle |
|---|---|---|
| GEMINI_API_KEY | oui | Clé Google AI Studio |
| ADMIN_CODE | oui | Code administrateur (long et secret) |
| VENDEURS_ILLIMITES | non | Vendeurs illimités, jamais décomptés : `empreinte=Nom;empreinte2=Nom2` (empreinte = 32 premiers caractères hex du SHA-256 du code en majuscules ; le code lui-même n'est stocké nulle part) |
| GEMINI_TEXT_MODEL | non | défaut gemini-3.6-flash |
| GEMINI_IMAGE_MODEL | non | défaut gemini-3.1-flash-image |

Après avoir ajouté ou modifié une variable, relancer un déploiement.

## Règles de la maison
La vraie photo reste toujours en premier ; les photos IA sont marquées « Studio IA ». On ne cache jamais un défaut et on ne change jamais la couleur réelle.
