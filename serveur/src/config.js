'use strict';
// Configuration du serveur : valeurs par défaut, remplacées par serveur/config.json s'il existe.
// Les chemins relatifs partent du dossier serveur/.

const fs = require('node:fs');
const path = require('node:path');

const RACINE = path.resolve(__dirname, '..');

const DEFAUT = {
  api: {
    hote: '127.0.0.1',        // derrière Caddy en production : n'écoute que la machine elle-même
    port: 3000,
    trustProxy: 'loopback',   // adresse réelle du visiteur lue dans X-Forwarded-For de Caddy seulement
    cookieSecure: true,       // cookie __Host- (HTTPS ; les navigateurs l'acceptent aussi sur http://localhost)
    origineSite: null,        // ex. "https://imprimantes.mon-domaine.fr" si le site est sur un autre domaine
  },
  agent: {
    hote: '0.0.0.0',
    port: 8443,
    id: 'agent-maison',       // seul identifiant d'agent accepté (= CN de son certificat)
    ipsAutorisees: [],        // vide = toutes ; sinon ex. ["203.0.113.7"] (IP publique de ta box)
    bannissement: { echecs: 5, dureeMs: 3600e3 },   // 5 échecs en 1 h -> IP coupée pendant 1 h
  },
  pki: {
    ca: 'pki/ca.crt.pem',
    cert: 'pki/serveur.crt.pem',
    cle: 'pki/serveur.key.pem',
  },
  donnees: 'data',
  uploadMaxOctets: 200 * 1024 * 1024,
  session: {
    dureeMaxMs: 12 * 3600e3,
    inactiviteMs: 30 * 60e3,
    etape2faMs: 5 * 60e3,
    confirmationMs: 10 * 60e3,   // un code 2FA de moins de 10 min suffit pour les actions sensibles
  },
};

function fusion(base, ajout) {
  const r = { ...base };
  for (const [k, v] of Object.entries(ajout || {})) {
    r[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object'
      ? fusion(base[k], v) : v;
  }
  return r;
}

function charger(fichier = process.env.CONFIG || path.join(RACINE, 'config.json')) {
  let perso = {};
  if (fs.existsSync(fichier)) perso = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  const c = fusion(DEFAUT, perso);
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(RACINE, p));
  c.pki = { ca: abs(c.pki.ca), cert: abs(c.pki.cert), cle: abs(c.pki.cle) };
  c.donnees = abs(c.donnees);
  fs.mkdirSync(c.donnees, { recursive: true });
  return c;
}

module.exports = { charger, RACINE };
