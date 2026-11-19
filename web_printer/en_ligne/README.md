# Site en ligne (à héberger plus tard)

Deux pages qui pilotent tes machines **à travers l'API en ligne** (pas l'imprimante directement) :

| Fichier | Rôle |
| --- | --- |
| `connexion.html` + `connexion.js` | e-mail + mot de passe, puis code 2FA (ou code de secours) |
| `index.html` + `app.js` | page « Imprimer » : état en direct, caméra, gcodes avec miniatures, envoi, emplacement ACE, pause / reprise / annulation |
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
