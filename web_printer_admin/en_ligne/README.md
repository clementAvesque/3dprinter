# Site en ligne (à héberger plus tard)

Deux pages qui pilotent tes machines **à travers l'API en ligne** (pas l'imprimante directement) :

| Fichier | Rôle |
| --- | --- |
| `connexion.html` + `connexion.js` | e-mail + mot de passe, puis code 2FA (ou code de secours) |
| `index.html` + `app.js` | page « Imprimer » : état en direct, caméra + lumière, gcodes avec miniatures, envoi, lancement sur un emplacement ACE, pause / reprise / annulation, vitesse / débit / ventilateur, ACE (fils des 4 emplacements, séchage), températures, mouvements de la buse (home, déplacements, moteurs), chargement / déchargement du filament |
| `profil.html` + `profil.js` | mon profil : changer le mot de passe, appareils connectés (et les déconnecter), nouveaux codes de secours |
| `commun.js` | appels à l'API (jeton anti-CSRF, retour à la connexion si la session expire, code 2FA redemandé pour les actions sensibles) |
| `style.css` | thème clair / sombre, adapté au téléphone |
| `config.js` | **adresse de l'API** (seul fichier à régler) |

Rien n'est en ligne pour l'instant : ces fichiers ne sont servis par aucun serveur.

## Les héberger plus tard : deux possibilités

**1. Sur le serveur de l'API (recommandé)** : `config.js` → `window.API_BASE = ''`.
Copier ce dossier en `serveur/site/` et, dans `serveur/src/api.js`, juste après `app.use('/api/v1', api);` :

```js
app.use(express.static(path.join(__dirname, '..', 'site'), { extensions: ['html'] }));
```

puis ajouter `COPY serveur/site ./site` au `Dockerfile`. Site et API ont alors la même adresse : le cookie de
session reste en `SameSite=Strict`, aucun réglage CORS, protection maximale.

**2. Ailleurs (Vercel, autre domaine)** : `config.js` → `window.API_BASE = 'https://passerelle-printer-server.fly.dev'`.
Le navigateur protège alors l'API contre les autres sites ; pour que celui-ci passe, il faut sur le serveur :
- `fly secrets set ORIGINE_SITE=https://ton-site.vercel.app` (autorise cette seule origine, avec cookies) ;
- un cookie de session en `SameSite=None` (au lieu de `Strict`) ;
- `Cross-Origin-Resource-Policy: cross-origin` sur les miniatures et la caméra (sinon les images sont bloquées).

C'est faisable mais un peu moins protégé que la solution 1.

## Application sur le téléphone (PWA)

Le site admin s'installe comme une application (`manifest.webmanifest`, `sw.js`, icônes dans `icones/`).
Un navigateur n'installe une PWA que depuis une adresse **HTTPS** (ou `localhost`). Pour l'avoir sur ton
téléphone sans publier l'admin sur internet, le plus simple est **Tailscale** (gratuit pour un usage perso) :
un réseau privé entre tes appareils, avec une adresse HTTPS que personne d'autre ne peut ouvrir.

1. Installe Tailscale sur ce PC et sur ton téléphone, avec le même compte.
2. Sur le PC, relance le relais en autorisant l'adresse Tailscale du PC (elle s'affiche avec `tailscale status`
   ou dans l'application, sous la forme `mon-pc.nom-du-reseau.ts.net`) :
   `$env:ORIGINES='https://mon-pc.nom-du-reseau.ts.net'; node web_printer_admin/test-en-ligne.js`
3. Toujours sur le PC : `tailscale serve --bg 5510`
4. Sur le téléphone (Tailscale allumé), ouvre `https://mon-pc.nom-du-reseau.ts.net/connexion.html`, puis
   « Installer l'application » (Android, Chrome) ou Partager → « Sur l'écran d'accueil » (iPhone, Safari).

Le PC doit rester allumé avec le relais lancé. L'API, elle, reste protégée par ton mot de passe et ta 2FA.
