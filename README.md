# Imprimantes 3D : pilotage à distance et boutique en ligne

## État : version bêta (`v0.1.0-beta`, 22 novembre 2026)

Bêta **fonctionnelle**, mais **non payante** et à **accès réduit** :

- **Fonctionne de bout en bout** : dépôt des STL, découpe OrcaSlicer sur le serveur (supports arbre, profil
  Kobra 3 PLA Haute Vitesse), devis avec aperçu 3D, commandes groupées, espace compte (adresses, mot de passe,
  suppression du compte), galerie des projets réalisés, plaques envoyées dans `a_faire/` sur l'imprimante,
  validation de fin d'impression, bon de colis, pilotage et suivi 3D depuis l'admin.
- **Non payante** : Stripe n'est pas branché en production (pas de clés sur Fly). Aucune commande ne peut
  être payée : le site le dit au moment de commander. Pour ouvrir le paiement :
  `python serveur\scripts\stripe_configurer.py` (mode test d'abord), puis passage aux clés live.
- **Accès réduit** : l'admin (pilotage de l'imprimante, boutique) est réservé aux comptes admin avec code 2FA ;
  le site client est en ligne mais réservé aux essais (pas d'ouverture publique, pas de paiement).
- Avant une ouverture publique : brancher Stripe, relire les CGV / mentions légales, mettre à jour le
  Raspberry à chaque changement de `client_printer/`, `agent/` ou `protocole/`.

| Dossier | Rôle |
| --- | --- |
| `client_printer/` | librairie Python qui parle à l'imprimante (Moonraker / Rinkhals) |
| `agent/` | programme du Raspberry : relie l'imprimante au serveur en ligne |
| `serveur/` | serveur Node en ligne (Fly.io) : API, boutique, découpe OrcaSlicer, paiement Stripe |
| `web_printer_user/front/` | site client (Vue), servi par le serveur |
| `web_printer_admin/` | admin : local (Flask, `app.py`) et en ligne (`en_ligne/`, via le serveur) |
| `protocole/` | commandes autorisées entre serveur et agent |

## Travailler depuis un autre poste

Git ne contient que le code et la configuration **sans secret** (voir `.gitignore`). Après `git clone` :

1. **Dépendances** (recréées, jamais dans git) :
   ```powershell
   cd serveur; npm ci; cd ..
   cd web_printer_user/front; npm ci; cd ../..
   python -m venv .venv
   .venv\Scripts\pip install -r client_printer/requirements.txt -r web_printer_admin/requirements.txt
   ```
2. **Développer en local** (base séparée, e-mails dans le terminal) :
   `node --env-file=serveur/dev.env serveur/src/index.js` puis, pour le site client, `npm run dev` dans
   `web_printer_user/front`. La base `serveur/data-dev/` se crée toute seule. Il faut aussi des certificats
   de développement : `cd serveur; npm run pki` (créés dans `serveur/pki/`, jamais dans git).
3. **Déployer** : installe `flyctl`, `fly auth login`, puis `fly deploy` depuis la racine. Les secrets
   (certificats, Brevo, Stripe) sont **déjà sur Fly** : rien à recopier pour déployer.
4. **Admin local et agent** : ils ont besoin de fichiers qui ne sont pas dans git, à recopier à la main depuis
   l'ancien poste si besoin (clé USB, gestionnaire de mots de passe…) :
   - `agent/config.json` et `agent/secrets/` : seulement pour faire tourner l'agent depuis ce poste
     (normalement il tourne sur le Raspberry, qui les a déjà) ;
   - `serveur/pki/` : seulement pour régénérer les certificats de l'agent (`npm run fly:secrets`).

Les données (`client_printer/gcode`, `image`, `data`) se recréent au premier lancement : gcodes re-téléchargés
depuis l'imprimante, historiques repartant de zéro.
