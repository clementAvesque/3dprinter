// Adresse de l'API utilisée par le site.
//  - '' : le site est servi par le serveur de l'API lui-même (même adresse) -> le plus sûr, rien d'autre à régler
//  - 'https://passerelle-printer-server.fly.dev' : le site est hébergé ailleurs (Vercel...) -> il faut aussi
//    régler le serveur (voir README.md de ce dossier : ORIGINE_SITE et cookie SameSite=None)
window.API_BASE = '';
