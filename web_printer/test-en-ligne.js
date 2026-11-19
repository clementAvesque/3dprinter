// Test local du site avec la VRAIE API en ligne (Fly) et donc ta vraie imprimante (via ton agent).
//
//   node web_printer/test-en-ligne.js        puis ouvre  http://localhost:5510
//
// Les pages de web_printer/en_ligne sont servies ici, et tout ce qui commence par /api/v1 est relayé tel quel
// vers l'API Fly. Pour le navigateur, site et API ont la même adresse (localhost:5510) : le cookie de session
// reste en SameSite=Strict, aucun réglage à changer sur le serveur, rien n'est déployé.
//
// Sécurité : écoute uniquement sur 127.0.0.1 (invisible depuis le réseau), et le relais refuse toute requête
// d'écriture venant d'une autre page que celle-ci avant de la présenter à l'API comme venant de son propre site.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const API = new URL(process.env.API || 'https://passerelle-printer-server.fly.dev');
const PORT = Number(process.env.PORT || 5510);
const LOCAL = `http://localhost:${PORT}`;
const DOSSIER = path.join(__dirname, 'en_ligne');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const CSP = "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self'; connect-src 'self'; "
  + "font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
// en-têtes propres à une connexion : jamais recopiés d'un côté à l'autre
const SAUT = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);

function relayer(req, res) {
  const origine = req.headers.origin;
  const ecriture = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (origine && origine !== LOCAL && origine !== `http://127.0.0.1:${PORT}`) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ erreur: 'origine_refusee', detail: 'relais local : autre page refusée' }));
  }
  if (ecriture && !origine) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ erreur: 'origine_refusee', detail: 'relais local : origine absente' }));
  }
  const entetes = {};
  for (const [k, v] of Object.entries(req.headers)) if (!SAUT.has(k) && k !== 'referer') entetes[k] = v;
  entetes.host = API.host;
  if (origine) entetes.origin = API.origin;     // la page vérifiée ci-dessus parle au nom du site de l'API

  const amont = https.request({ hostname: API.hostname, port: API.port || 443, path: req.url, method: req.method,
    headers: entetes, servername: API.hostname }, (r) => {
    const h = {};
    for (const [k, v] of Object.entries(r.headers)) if (!SAUT.has(k) && k !== 'strict-transport-security') h[k] = v;
    res.writeHead(r.statusCode, h);
    r.pipe(res);                                  // en continu : SSE (/events) et caméra en direct passent
  });
  amont.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ erreur: 'api_injoignable', detail: e.message }));
  });
  res.on('close', () => amont.destroy());       // page fermée : on coupe aussi le flux vers Fly
  req.pipe(amont);
}

function fichier(req, res) {
  let p = decodeURIComponent(new URL(req.url, LOCAL).pathname);
  if (p === '/') p = '/index.html';
  if (!path.extname(p)) p += '.html';
  const complet = path.join(DOSSIER, path.normalize(p));
  if (!complet.startsWith(DOSSIER + path.sep) || path.basename(complet) === 'README.md') { res.writeHead(404); return res.end(); }
  fs.readFile(complet, (err, octets) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('introuvable'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(complet)] || 'application/octet-stream', 'Cache-Control': 'no-store',
      'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(octets);
  });
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return relayer(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  fichier(req, res);
}).on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Le port ${PORT} est déjà pris : relance avec un autre, ex. PORT=5511` : e.message);
  process.exit(1);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Site de test : ${LOCAL}/connexion.html`);
  console.log(`API relayée  : ${API.origin}  (ton agent doit tourner pour joindre l'imprimante)`);
});
