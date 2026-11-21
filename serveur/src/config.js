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
    // en-tête où l'hébergeur écrit la vraie IP du visiteur (Fly.io : "fly-client-ip", qu'il écrase
    // lui-même : un visiteur ne peut pas le falsifier). null = X-Forwarded-For selon trustProxy.
    enteteIpClient: null,
  },
  agent: {
    hote: '0.0.0.0',
    port: 8443,
    id: 'agent-maison',       // seul identifiant d'agent accepté (= CN de son certificat)
    ipsAutorisees: [],        // vide = toutes ; sinon ex. ["203.0.113.7"] (IP publique de ta box)
    // 5 échecs en 1 h -> IP coupée pendant 1 h ; le PC lui-même (127.0.0.1) n'est jamais banni
    bannissement: { echecs: 5, dureeMs: 3600e3, exempterLocal: true },
    // derrière un proxy TCP (Fly.io) : il ajoute la vraie IP de l'agent en tête de connexion
    // (PROXY protocol v1). Sans ça, toutes les connexions viendraient de l'IP du proxy.
    proxyProtocol: false,
  },
  pki: {
    ca: 'pki/ca.crt.pem',
    cert: 'pki/serveur.crt.pem',
    cle: 'pki/serveur.key.pem',
  },
  donnees: 'data',
  // site client compilé (npm run build dans web_printer_user/front), servi par le serveur à la racine ;
  // vide = API seule. Dans l'image Docker : /app/web_printer_user/front/dist (voir Dockerfile)
  siteClient: '../web_printer_user/front/dist',
  // découpe des devis par OrcaSlicer : commande à lancer (vide = pas de découpe, les devis restent « attente »).
  // Dans l'image Docker : ORCA_CMD="xvfb-run -a /opt/orca/AppRun" (voir Dockerfile)
  orca: { commande: '', profils: 'orca', delaiMs: 15 * 60e3, intervalleMs: 10e3 },
  uploadMaxOctets: 200 * 1024 * 1024,
  // boutique (site client) : voir web_printer_user/CONCEPTION.md
  boutique: {
    // adresse publique du site client, utilisée dans les liens des e-mails (jamais l'en-tête Host :
    // un attaquant pourrait sinon faire pointer le lien « mot de passe oublié » vers son site)
    urlSite: 'https://passerelle-printer-server.fly.dev',
    prixGrammeCts: 20,                // 0,20 € par gramme de PLA
    emballageG: 50,                   // ajouté au poids des pièces pour la livraison
    livraison: [                      // poids du colis jusqu'à maxG -> prix
      { maxG: 250, cts: 500 }, { maxG: 500, cts: 650 }, { maxG: 1000, cts: 800 }, { maxG: 2000, cts: 1000 },
    ],
    livraisonParKgEnPlusCts: 200,     // au-delà de la dernière tranche, par kg entamé
    validationJours: 10,              // sans validation : remboursement automatique
    envoiJours: 60,                   // après validation : limite d'envoi
    objectifEnvoiJours: 14,
    stlMaxOctets: 50 * 1024 * 1024,
    stlConservationJours: 30,         // STL jamais commandé
    stlCommandeConservationJours: 730, // STL d'une commande payée : 2 ans
    session: { dureeMaxMs: 30 * 864e5, inactiviteMs: 7 * 864e5 },
    // e-mails : "journal" = écrits dans les logs du serveur (tant qu'aucun service n'est choisi),
    // "memoire" = gardés en mémoire (tests), "brevo" = vrais envois (voir src/courriel.js)
    courriel: { mode: 'journal', expediteur: 'Impression 3D <no-reply@example.com>', cleApi: '', templateId: '' },
  },
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

// réglages par variables d'environnement (hébergeurs comme Fly.io : fly.toml [env] et fly secrets),
// appliqués après config.json. Les secrets (certificats) ne sont jamais dans l'image Docker.
function depuisEnv(c, env = process.env) {
  const entier = (v) => (v === undefined ? undefined : Number(v));
  const liste = (v) => (v === undefined ? undefined : v.split(',').map((x) => x.trim()).filter(Boolean));
  const vrai = (v) => (v === undefined ? undefined : ['1', 'true', 'oui'].includes(v.toLowerCase()));
  const poser = (objet, cle, valeur) => { if (valeur !== undefined && !Number.isNaN(valeur)) objet[cle] = valeur; };
  poser(c.api, 'hote', env.API_HOTE);
  poser(c.api, 'port', entier(env.API_PORT));
  if (env.TRUST_PROXY !== undefined) c.api.trustProxy = /^\d+$/.test(env.TRUST_PROXY) ? Number(env.TRUST_PROXY) : env.TRUST_PROXY;
  poser(c.api, 'origineSite', env.ORIGINE_SITE);
  poser(c.api, 'enteteIpClient', env.ENTETE_IP_CLIENT?.toLowerCase());
  poser(c.agent, 'hote', env.AGENT_HOTE);
  poser(c.agent, 'port', entier(env.AGENT_PORT));
  poser(c.agent, 'id', env.AGENT_ID);
  poser(c.agent, 'ipsAutorisees', liste(env.AGENT_IPS_AUTORISEES));
  poser(c.agent, 'proxyProtocol', vrai(env.AGENT_PROXY_PROTOCOL));
  poser(c, 'donnees', env.DONNEES);
  poser(c, 'siteClient', env.SITE_CLIENT);
  poser(c.orca, 'commande', env.ORCA_CMD);
  poser(c.boutique, 'urlSite', env.URL_SITE);
  poser(c.boutique.courriel, 'mode', env.COURRIEL_MODE);
  poser(c.boutique.courriel, 'expediteur', env.COURRIEL_EXPEDITEUR);
  poser(c.boutique.courriel, 'cleApi', env.COURRIEL_CLE_API);     // secret : fly secrets, jamais dans fly.toml
  poser(c.boutique.courriel, 'templateId', env.COURRIEL_TEMPLATE_ID);   // numéro donné par scripts/brevo_template.py
  // certificats en base64 (fly secrets) : prioritaires sur les fichiers pki/
  const pem = (v) => (v ? Buffer.from(v, 'base64') : null);
  c.pkiPem = { ca: pem(env.PKI_CA_B64), cert: pem(env.PKI_CERT_B64), cle: pem(env.PKI_CLE_B64) };
  // clé publique de l'agent à enrôler au démarrage (évite d'avoir à copier un fichier sur le serveur)
  c.agentClePublique = env.AGENT_CLE_PUBLIQUE_B64 ? Buffer.from(env.AGENT_CLE_PUBLIQUE_B64, 'base64').toString('utf8') : null;
  return c;
}

function charger(fichier = process.env.CONFIG || path.join(RACINE, 'config.json'), env = process.env) {
  let perso = {};
  if (fs.existsSync(fichier)) perso = JSON.parse(fs.readFileSync(fichier, 'utf8'));
  const c = depuisEnv(fusion(DEFAUT, perso), env);
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(RACINE, p));
  c.pki = { ca: abs(c.pki.ca), cert: abs(c.pki.cert), cle: abs(c.pki.cle) };
  c.donnees = abs(c.donnees);
  c.siteClient = c.siteClient ? abs(c.siteClient) : '';
  c.orca.profils = abs(c.orca.profils);
  fs.mkdirSync(c.donnees, { recursive: true });
  return c;
}

// contenu PEM : variable d'environnement si présente, sinon le fichier
function lirePki(c, nom) {
  return c.pkiPem?.[nom] || fs.readFileSync(c.pki[nom]);
}

module.exports = { charger, lirePki, RACINE };
