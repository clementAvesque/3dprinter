'use strict';
// Tests de la boutique : comptes clients (inscription, vérification, mot de passe oublié), séparation
// avec les comptes admin, fichiers STL, devis, gestion admin des commandes, échéances et rappels.
//   npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { genererPki } = require('../scripts/pki');
const { charger } = require('../src/config');
const { demarrer } = require('../src/index');
const { analyserStl } = require('../src/stl');
const { prixLivraison, datesRappels } = require('../src/boutique');
const S = require('../src/securite');

const JOUR = 864e5;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boutique-test-'));
let srv, base, boite, totpAdmin;

// ------------------------------------------------------------------ outils

class Client {
  constructor(prefixe = '/api/client') { this.prefixe = prefixe; this.cookie = ''; this.csrf = ''; }
  async req(methode, chemin, corps, entetes = {}) {
    const h = { ...entetes };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf) h['x-csrf-token'] = this.csrf;
    if (corps !== undefined && !(corps instanceof FormData)) h['content-type'] = 'application/json';
    const res = await fetch(base + this.prefixe + chemin, { method: methode, headers: h,
      body: corps === undefined ? undefined : corps instanceof FormData ? corps : JSON.stringify(corps) });
    for (const c of res.headers.getSetCookie()) this.cookie = c.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const json = type.includes('json') ? await res.json() : null;
    return { statut: res.status, json, res };
  }
}

// cube binaire de `c` mm (12 triangles)
function cube(c = 20) {
  const s = [[0, 0, 0], [c, 0, 0], [c, c, 0], [0, c, 0], [0, 0, c], [c, 0, c], [c, c, c], [0, c, c]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + faces.length * 50);
  buf.writeUInt32LE(faces.length, 80);
  faces.forEach((f, i) => f.forEach((v, k) => s[v].forEach((x, d) => buf.writeFloatLE(x, 84 + i * 50 + 12 + k * 12 + d * 4))));
  return buf;
}

const dernierLien = (a, chemin) => {
  const m = [...boite].reverse().find((x) => x.a === a && x.texte.includes(chemin));
  return m && m.texte.match(new RegExp(`${chemin}\\?jeton=([A-Za-z0-9_-]+)`))[1];
};

function envoiStl(nom, octets) {
  const fd = new FormData();
  fd.append('fichier', new Blob([octets]), nom);
  return fd;
}

// attend la fin de la découpe d'un devis (file Orca)
async function devisDecoupe(c, id) {
  for (let i = 0; i < 200; i++) {
    const d = (await c.req('GET', `/devis/${id}`)).json;
    if (!['attente', 'decoupe'].includes(d.statut)) return d;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`devis ${id} jamais découpé`);
}
const gcodeDuDevis = (id) => {
  const d = srv.db.prepare('SELECT gcode_chemin FROM devis WHERE id = ?').get(id);
  return zlib.gunzipSync(fs.readFileSync(path.join(srv.config.donnees, d.gcode_chemin))).toString();
};

async function clientVerifie(email) {
  const c = new Client();
  assert.equal((await c.req('POST', '/inscription', { email, motdepasse: 'un-mot-de-passe-solide', nom: 'Test' })).statut, 200);
  const r = await c.req('POST', '/verifier', { jeton: dernierLien(email, '/verifier') });
  assert.equal(r.statut, 200, JSON.stringify(r.json));
  c.csrf = r.json.csrf;
  return c;
}

before(async () => {
  genererPki({ fichiersServeur: { ca: path.join(dir, 'pki', 'ca.crt.pem'), cert: path.join(dir, 'pki', 'serveur.crt.pem'),
    cle: path.join(dir, 'pki', 'serveur.key.pem') }, dossierAgent: path.join(dir, 'agent'), agentId: 'agent-test', bits: 2048 });
  const fichierConfig = path.join(dir, 'config.json');
  fs.writeFileSync(fichierConfig, JSON.stringify({
    api: { port: 0, cookieSecure: false },
    agent: { port: 0, hote: '127.0.0.1', id: 'agent-test' },
    pki: { ca: path.join(dir, 'pki', 'ca.crt.pem'), cert: path.join(dir, 'pki', 'serveur.crt.pem'), cle: path.join(dir, 'pki', 'serveur.key.pem') },
    donnees: path.join(dir, 'data'),
    boutique: { urlSite: 'https://boutique.test', courriel: { mode: 'memoire' } },
    siteClient: path.join(dir, 'site'),
    // faux Orca : même interface que le vrai (test/faux-orca.js)
    orca: { commande: [process.execPath, path.join(__dirname, 'faux-orca.js')], intervalleMs: 100 },
  }));
  // faux site client compilé (comme web_printer_user/front/dist)
  fs.mkdirSync(path.join(dir, 'site', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'site', 'index.html'), '<!doctype html><div id="app"></div>');
  fs.writeFileSync(path.join(dir, 'site', 'assets', 'index-abc.js'), 'console.log(1)');
  srv = await demarrer(charger(fichierConfig));
  base = `http://127.0.0.1:${srv.serveurApi.address().port}`;
  boite = srv.app.locals.courriel.boite;
  totpAdmin = S.nouveauSecretTotp();
  srv.db.prepare('INSERT INTO utilisateurs (email, nom, role, hash, totp_secret, cree) VALUES (?, ?, ?, ?, ?, ?)')
    .run('admin@test.local', 'Admin', 'admin', await S.hacher('mot-de-passe-de-test!'), totpAdmin, Date.now());
});

after(async () => {
  await srv.arreter();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ règles

test('rappels : 10 jours -> J5 et J8 ; 60 jours -> J30, J45, J55, J58', () => {
  const j = (l) => l.map(([p, t]) => [p, t / JOUR]);
  assert.deepEqual(j(datesRappels(0, 10 * JOUR)), [['j5', 5], ['j2', 8]]);
  assert.deepEqual(j(datesRappels(0, 60 * JOUR)), [['moitie', 30], ['quart', 45], ['j5', 55], ['j2', 58]]);
});

test('livraison : 5 € de base puis croissante avec le poids', () => {
  const B = srv.config.boutique;
  assert.equal(prixLivraison(B, 100), 500);          // 150 g avec l'emballage
  assert.equal(prixLivraison(B, 400), 650);
  assert.equal(prixLivraison(B, 900), 800);
  assert.equal(prixLivraison(B, 1900), 1000);
  assert.equal(prixLivraison(B, 2500), 1200);        // 2,55 kg : 1 kg entamé au-delà de 2 kg
});

test('STL : binaire et texte lus, le reste refusé', () => {
  const b = analyserStl(cube(20));
  assert.equal(b.triangles, 12);
  assert.deepEqual(b.dims, [20, 20, 20]);
  assert.ok(Math.abs(b.volume - 8000) < 1);
  const txt = `solid t\n${[[0, 0, 0], [10, 0, 0], [0, 10, 0]].map(() => '').join('')}facet normal 0 0 1\n outer loop\n`
    + '  vertex 0 0 0\n  vertex 10 0 0\n  vertex 0 10 5\n endloop\nendfacet\nendsolid t\n';
  assert.deepEqual(analyserStl(Buffer.from(txt)).dims, [10, 10, 5]);
  assert.throws(() => analyserStl(Buffer.from('pas un stl du tout '.repeat(10))));
  assert.throws(() => analyserStl(Buffer.alloc(10)));
});

// ------------------------------------------------------------------ site client

test('site client : pages de l\'appli -> index.html, fichiers en cache, API et fichiers absents -> 404', async () => {
  for (const page of ['/', '/verifier?jeton=abc', '/reinitialiser?jeton=abc', '/devis/12']) {
    const r = await fetch(base + page);
    assert.equal(r.status, 200, page);
    assert.match(r.headers.get('content-type'), /text\/html/, page);
    assert.equal(r.headers.get('cache-control'), 'no-cache', page);
  }
  const js = await fetch(`${base}/assets/index-abc.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('cache-control'), /immutable/);
  for (const absent of ['/assets/absent.js', '/absent.png', '/api/client/inconnu', '/api/v1/inconnu']) {
    const r = await fetch(base + absent);
    assert.equal(r.status, 404, absent);
    assert.equal((await r.json()).erreur, 'route_inconnue', absent);
  }
});

// ------------------------------------------------------------------ comptes clients

test('inscription : e-mail de vérification, pas de connexion avant, lien à usage unique', async () => {
  const c = new Client();
  const r = await c.req('POST', '/inscription', { email: 'alice@test.local', motdepasse: 'un-mot-de-passe-solide', nom: 'Alice' });
  assert.equal(r.statut, 200);
  const jeton = dernierLien('alice@test.local', '/verifier');
  assert.ok(jeton, 'lien de vérification envoyé');
  assert.ok(boite.at(-1).texte.includes('https://boutique.test/verifier?jeton='), 'lien vers le site configuré, pas l\'en-tête Host');
  assert.equal((await c.req('POST', '/connexion', { email: 'alice@test.local', motdepasse: 'un-mot-de-passe-solide' })).json.erreur, 'email_non_verifie');
  const v = await c.req('POST', '/verifier', { jeton });
  assert.equal(v.statut, 200);
  c.csrf = v.json.csrf;
  assert.equal((await c.req('GET', '/moi')).json.client.email, 'alice@test.local');
  assert.equal((await new Client().req('POST', '/verifier', { jeton })).statut, 400, 'lien déjà utilisé');
});

test('inscription avec une adresse déjà prise : même réponse, e-mail au vrai propriétaire', async () => {
  const r = await new Client().req('POST', '/inscription', { email: 'alice@test.local', motdepasse: 'autre-mot-de-passe-1', nom: 'Intrus' });
  assert.equal(r.statut, 200);
  assert.equal(boite.at(-1).a, 'alice@test.local');
  assert.match(boite.at(-1).sujet, /déjà un compte/);
  assert.equal(srv.db.prepare('SELECT count(*) n FROM clients WHERE email = ?').get('alice@test.local').n, 1);
});

test('inscription répétée d\'un compte jamais confirmé : le lien de vérification est renvoyé', async () => {
  const inscrire = () => new Client().req('POST', '/inscription', { email: 'oublieux@test.local', motdepasse: 'un-mot-de-passe-solide', nom: 'Oublieux' });
  assert.equal((await inscrire()).statut, 200);
  const premier = dernierLien('oublieux@test.local', '/verifier');
  assert.equal((await inscrire()).statut, 200);
  const second = dernierLien('oublieux@test.local', '/verifier');
  assert.ok(second && second !== premier, 'nouveau lien envoyé');
  assert.equal((await new Client().req('POST', '/verifier', { jeton: premier })).statut, 400, 'l\'ancien lien est annulé');
  assert.equal((await new Client().req('POST', '/verifier', { jeton: second })).statut, 200);
});

test('service d\'e-mails en panne : 503 clair à l\'inscription, rien de trahi sur « mot de passe oublié »', async () => {
  const courriel = srv.app.locals.courriel;
  const envoyer = courriel.envoyer;
  courriel.envoyer = async () => { throw Object.assign(new Error('Brevo a refusé l\'e-mail (HTTP 401)'), { code: 'COURRIEL' }); };
  try {
    const r = await new Client().req('POST', '/inscription', { email: 'panne@test.local', motdepasse: 'un-mot-de-passe-solide', nom: 'Panne' });
    assert.equal(r.statut, 503);
    assert.equal(r.json.erreur, 'courriel_indisponible');
    const oubli = await new Client().req('POST', '/mot-de-passe/oubli', { email: 'alice@test.local' });
    assert.equal(oubli.statut, 200, 'même réponse qu\'une adresse inconnue');
    // deux essais de plus (« renvoyer le lien »), toujours en panne : 3 échecs au total
    for (let i = 0; i < 2; i++) {
      assert.equal((await new Client().req('POST', '/verification/renvoyer', { email: 'panne@test.local' })).statut, 200);
    }
  } finally {
    courriel.envoyer = envoyer;
  }
  // service revenu : les envois ratés ne comptent pas dans la limite de 3 liens par heure
  assert.equal((await new Client().req('POST', '/verification/renvoyer', { email: 'panne@test.local' })).statut, 200);
  const jeton = dernierLien('panne@test.local', '/verifier');
  assert.ok(jeton, 'lien envoyé malgré les 3 échecs précédents');
  assert.equal((await new Client().req('POST', '/verifier', { jeton })).statut, 200);
});

test('mot de passe oublié : lien de 30 min à usage unique, sessions fermées, ancien mot de passe refusé', async () => {
  const ancienne = new Client();
  const a = await ancienne.req('POST', '/connexion', { email: 'alice@test.local', motdepasse: 'un-mot-de-passe-solide' });
  assert.equal(a.statut, 200);
  const inconnu = await new Client().req('POST', '/mot-de-passe/oubli', { email: 'personne@test.local' });
  assert.equal(inconnu.statut, 200, 'même réponse pour une adresse inconnue');
  assert.equal((await new Client().req('POST', '/mot-de-passe/oubli', { email: 'alice@test.local' })).statut, 200);
  const jeton = dernierLien('alice@test.local', '/reinitialiser');
  const j = srv.db.prepare('SELECT expire_le - cree_le d FROM jetons_email WHERE id = ?').get(S.sha256(jeton));
  assert.equal(j.d, 30 * 60e3);
  const c = new Client();
  assert.equal((await c.req('POST', '/mot-de-passe/reinitialiser', { jeton, motdepasse: 'court' })).statut, 400);
  const r = await c.req('POST', '/mot-de-passe/reinitialiser', { jeton, motdepasse: 'nouveau-mot-de-passe-ok' });
  assert.equal(r.statut, 200);
  assert.equal((await new Client().req('POST', '/mot-de-passe/reinitialiser', { jeton, motdepasse: 'encore-un-autre-mdp' })).statut, 400);
  assert.equal((await ancienne.req('GET', '/moi')).statut, 401, 'anciennes sessions fermées');
  assert.equal((await new Client().req('POST', '/connexion', { email: 'alice@test.local', motdepasse: 'un-mot-de-passe-solide' })).statut, 401);
  assert.equal((await new Client().req('POST', '/connexion', { email: 'alice@test.local', motdepasse: 'nouveau-mot-de-passe-ok' })).statut, 200);
});

test('comptes séparés : une session client n\'ouvre pas l\'API admin', async () => {
  const c = await clientVerifie('bob@test.local');
  const admin = new Client('/api/v1');
  admin.cookie = c.cookie;
  admin.csrf = c.csrf;
  assert.equal((await admin.req('GET', '/machines')).statut, 401);
  assert.equal((await admin.req('GET', '/boutique/resume')).statut, 401);
});

test('protections : sans jeton CSRF ou depuis une autre origine -> 403', async () => {
  const c = await clientVerifie('carol@test.local');
  const sans = Object.assign(new Client(), { cookie: c.cookie });
  assert.equal((await sans.req('POST', '/adresses', { nom_complet: 'C', ligne1: '1 rue', code_postal: '75001', ville: 'Paris' })).statut, 403);
  const r = await c.req('POST', '/connexion', { email: 'carol@test.local', motdepasse: 'x' }, { origin: 'https://site-pirate.example' });
  assert.equal(r.statut, 403);
});

// ------------------------------------------------------------------ fichiers, devis, adresses

let alice, fichierId;

test('STL : envoi, lecture par son propriétaire seulement, refus du reste', async () => {
  alice = new Client();
  const co = await alice.req('POST', '/connexion', { email: 'alice@test.local', motdepasse: 'nouveau-mot-de-passe-ok' });
  alice.csrf = co.json.csrf;
  assert.equal((await new Client().req('POST', '/fichiers', envoiStl('cube.stl', cube()))).statut, 401);
  const r = await alice.req('POST', '/fichiers', envoiStl('cube.stl', cube(20)));
  assert.equal(r.statut, 201, JSON.stringify(r.json));
  assert.deepEqual(r.json.dims_mm, [20, 20, 20]);
  fichierId = r.json.id;
  const f = srv.db.prepare('SELECT * FROM fichiers_stl WHERE id = ?').get(fichierId);
  assert.ok(f.expire_le - f.cree_le === 30 * JOUR, 'gardé 30 jours tant qu\'il n\'est pas commandé');
  assert.ok(fs.statSync(path.join(srv.config.donnees, f.chemin)).size < cube(20).length + 50, 'stocké compressé');
  const lu = await alice.req('GET', `/fichiers/${fichierId}`);
  assert.deepEqual(Buffer.from(await lu.res.arrayBuffer()), cube(20));
  const bob = await clientVerifie('bob2@test.local');
  assert.equal((await bob.req('GET', `/fichiers/${fichierId}`)).statut, 404, 'fichier d\'un autre client');
  assert.equal((await alice.req('POST', '/fichiers', envoiStl('image.png', cube()))).json.erreur, 'stl_attendu');
  assert.equal((await alice.req('POST', '/fichiers', envoiStl('faux.stl', Buffer.from('rien'.repeat(40))))).json.erreur, 'stl_invalide');
});

test('devis : réglages bornés, pièce trop grande refusée, fichier d\'un autre refusé', async () => {
  const reglages = { remplissage_pct: 15, couches_surface: 3, proprete: 'fine' };
  const ok = await alice.req('POST', '/devis', { imprimante_id: 'kobra-1', reglages, pieces: [{ fichier_id: fichierId, quantite: 2, pos_mm: [10, 10] }] });
  assert.equal(ok.statut, 201, JSON.stringify(ok.json));
  assert.equal(ok.json.statut, 'attente');
  assert.equal(ok.json.reglages.proprete, 'fine');
  assert.equal(ok.json.pieces[0].quantite, 2);
  for (const r of [{ ...reglages, remplissage_pct: 3 }, { ...reglages, couches_surface: 11 }, { ...reglages, proprete: 'ultra' }, { ...reglages, autre: 1 }]) {
    assert.equal((await alice.req('POST', '/devis', { imprimante_id: 'kobra-1', reglages: r, pieces: [{ fichier_id: fichierId, quantite: 1 }] })).statut, 400);
  }
  const gros = await alice.req('POST', '/fichiers', envoiStl('gros.stl', cube(300)));
  const r = await alice.req('POST', '/devis', { imprimante_id: 'kobra-1', reglages, pieces: [{ fichier_id: gros.json.id, quantite: 1 }] });
  assert.equal(r.json.erreur, 'piece_trop_grande');
  const bob = await clientVerifie('bob3@test.local');
  assert.equal((await bob.req('POST', '/devis', { imprimante_id: 'kobra-1', reglages, pieces: [{ fichier_id: fichierId, quantite: 1 }] })).json.erreur, 'fichier_inconnu');
  assert.equal((await alice.req('GET', '/devis')).json.length, 1);
});

test('découpe : le serveur découpe le devis -> poids, prix, aperçu réservé au client', async () => {
  const carol = new Client();
  const cx = await carol.req('POST', '/connexion', { email: 'carol@test.local', motdepasse: 'un-mot-de-passe-solide' });
  assert.equal(cx.statut, 200, JSON.stringify(cx.json));
  carol.csrf = cx.json.csrf;
  const f = await carol.req('POST', '/fichiers', envoiStl('cube.stl', cube(20)));
  const reglages = { remplissage_pct: 15, couches_surface: 3, proprete: 'fine' };
  const creer = (r, quantite = 2) => carol.req('POST', '/devis', { imprimante_id: 'kobra-1', reglages: { ...reglages, ...r },
    pieces: [{ fichier_id: f.json.id, quantite }] });

  const ok = await creer({});
  assert.equal(ok.statut, 201);
  const d = await devisDecoupe(carol, ok.json.id);
  assert.equal(d.statut, 'pret', d.erreur);
  assert.equal(d.poids_g, 12.5);
  assert.equal(d.prix_matiere_cts, 250, '12,5 g x 0,20 €');
  assert.equal(d.livraison_cts, 500);
  assert.equal(d.total_cts, 750);
  assert.equal(d.duree_s, 3723);
  assert.equal(d.nb_couches, 3);
  const g = gcodeDuDevis(d.id);
  assert.match(g, /; pieces = 2/, 'une copie du STL par exemplaire');
  assert.match(g, /; layer_height = 0\.2\n; ironing_type = top\n; sparse_infill_density = 15%\n; top_shell_layers = 3/);

  // aperçu : réservé au propriétaire, jamais le gcode lui-même
  const meta = await carol.req('GET', `/devis/${d.id}/trajets`);
  assert.equal(meta.statut, 200);
  assert.equal(meta.json.layers.length, 3);
  const bin = await carol.req('GET', `/devis/${d.id}/trajets-bin`);
  assert.equal((await bin.res.arrayBuffer()).byteLength, meta.json.segments * 9);
  const bob = new Client();
  bob.csrf = (await bob.req('POST', '/connexion', { email: 'bob@test.local', motdepasse: 'un-mot-de-passe-solide' })).json.csrf;
  assert.equal((await bob.req('GET', `/devis/${d.id}/trajets`)).statut, 404);
  assert.equal((await carol.req('GET', `/devis/${d.id}/gcode`)).statut, 404, 'pas de route gcode côté client');

  // Stripe pas configuré sur ce serveur : la commande le dit, sans rien créer
  const adr = await carol.req('POST', '/adresses', { nom_complet: 'Carol', ligne1: '2 rue Test', code_postal: '69001', ville: 'Lyon' });
  const cmd = await carol.req('POST', '/commandes', { devis_id: d.id, adresse_id: adr.json.id });
  assert.equal(cmd.statut, 503);
  assert.equal(cmd.json.erreur, 'paiement_non_configure');
  assert.equal(srv.db.prepare('SELECT count(*) n FROM commandes WHERE devis_id = ?').get(d.id).n, 0);

  // « rapide » : 0,28 mm (la Kobra 3 0.4 n'accepte pas 0,4 mm), sans lissage
  const rapide = await devisDecoupe(carol, (await creer({ proprete: 'rapide' }, 1)).json.id);
  assert.match(gcodeDuDevis(rapide.id), /; layer_height = 0\.28\n; ironing_type = no ironing/);

  // échecs : message clair au client, aucun détail interne
  const panne = await devisDecoupe(carol, (await creer({ remplissage_pct: 99 }, 1)).json.id);
  assert.equal(panne.statut, 'erreur');
  assert.match(panne.erreur, /La découpe a échoué/);
  const deux = await devisDecoupe(carol, (await creer({ remplissage_pct: 98 }, 1)).json.id);
  assert.match(deux.erreur, /ne tiennent pas toutes sur un seul plateau/);
  const memoire = await devisDecoupe(carol, (await creer({ remplissage_pct: 97 }, 1)).json.id);
  assert.match(memoire.erreur, /trop chargé pour être découpé en une fois/);
  assert.equal((await carol.req('GET', `/devis/${panne.id}/trajets`)).statut, 409);

  // relance d'un devis en erreur : de nouveau en file, redécoupé ; impossible sur un devis prêt
  const relance = await carol.req('POST', `/devis/${panne.id}/relancer`, {});
  assert.equal(relance.statut, 200);
  assert.equal(relance.json.statut, 'attente');
  assert.equal((await devisDecoupe(carol, panne.id)).statut, 'erreur', 'le faux Orca échoue encore à 99 %');
  assert.equal((await carol.req('POST', `/devis/${d.id}/relancer`, {})).json.erreur, 'devis_pas_en_erreur');
  assert.equal((await bob.req('POST', `/devis/${panne.id}/relancer`, {})).statut, 404);

  // pas plus de 3 devis en cours de découpe par client
  const carolId = srv.db.prepare('SELECT id FROM clients WHERE email = ?').get('carol@test.local').id;
  const ins = srv.db.prepare("INSERT INTO devis (client_id, imprimante_id, remplissage_pct, couches_surface, proprete_mm, statut, cree_le) VALUES (?, 'kobra-1', 15, 3, 0.2, 'decoupe', ?)");
  const ids = [1, 2, 3].map(() => ins.run(carolId, Date.now()).lastInsertRowid);
  const trop = await creer({}, 1);
  assert.equal(trop.statut, 429);
  assert.equal(trop.json.erreur, 'trop_de_devis');

  // progression : pendant la découpe (temps écoulé + estimation), dans la file (devis devant)
  srv.db.prepare('UPDATE devis SET decoupe_debut_le = ? WHERE id = ?').run(Date.now() - 5000, ids[0]);
  const p = (await carol.req('GET', `/devis/${ids[0]}`)).json.progression;
  assert.ok(p.depuis_s >= 4 && p.depuis_s <= 7, JSON.stringify(p));
  assert.ok(p.estimee_s >= 15);
  assert.equal((await carol.req('DELETE', `/devis/${ids[0]}`)).json.erreur, 'decoupe_en_cours');
  assert.equal(d.progression, null, 'devis prêt : plus de progression');
  for (const id of ids) srv.db.prepare('DELETE FROM devis WHERE id = ?').run(id);
});

test('suppression d\'un devis : devis, STL (base + disque) et gcode effacés ; STL partagé gardé', async () => {
  const carol = new Client();
  carol.csrf = (await carol.req('POST', '/connexion', { email: 'carol@test.local', motdepasse: 'un-mot-de-passe-solide' })).json.csrf;
  const reglages = { remplissage_pct: 15, couches_surface: 3, proprete: 'fine' };
  const envoyer = async (nom) => (await carol.req('POST', '/fichiers', envoiStl(nom, cube(12)))).json.id;
  const creer = async (fichiers) => (await devisDecoupe(carol, (await carol.req('POST', '/devis', { imprimante_id: 'kobra-1', reglages,
    pieces: fichiers.map((id) => ({ fichier_id: id, quantite: 1 })) })).json.id));

  const seul = await envoyer('seul.stl'), partage = await envoyer('partage.stl');
  const d1 = await creer([seul, partage]);
  const d2 = await creer([partage]);
  assert.equal(d1.statut, 'pret');
  const fichierDisque = (id) => srv.db.prepare('SELECT chemin FROM fichiers_stl WHERE id = ?').get(id)?.chemin;
  const disqueSeul = path.join(srv.config.donnees, fichierDisque(seul));
  const gcode = path.join(srv.config.donnees, srv.db.prepare('SELECT gcode_chemin FROM devis WHERE id = ?').get(d1.id).gcode_chemin);
  assert.ok(fs.existsSync(disqueSeul) && fs.existsSync(gcode));

  // un autre client ne peut pas le supprimer
  const bob = new Client();
  bob.csrf = (await bob.req('POST', '/connexion', { email: 'bob@test.local', motdepasse: 'un-mot-de-passe-solide' })).json.csrf;
  assert.equal((await bob.req('DELETE', `/devis/${d1.id}`)).statut, 404);

  assert.equal((await carol.req('DELETE', `/devis/${d1.id}`)).statut, 200);
  assert.equal((await carol.req('GET', `/devis/${d1.id}`)).statut, 404);
  assert.equal(fichierDisque(seul), undefined, 'STL retiré de la base');
  assert.ok(!fs.existsSync(disqueSeul), 'STL retiré du disque');
  assert.ok(!fs.existsSync(gcode), 'gcode supprimé');
  assert.ok(!fs.readdirSync(path.join(srv.config.donnees, 'gcode')).some((n) => n.startsWith(`devis-${d1.id}.`)), 'aperçu supprimé');
  // le STL partagé reste pour l'autre devis, toujours prêt
  assert.ok(fichierDisque(partage));
  assert.equal((await carol.req('GET', `/devis/${d2.id}`)).json.statut, 'pret');
  // en supprimant le dernier devis qui l'utilise, il part aussi
  assert.equal((await carol.req('DELETE', `/devis/${d2.id}`)).statut, 200);
  assert.equal(fichierDisque(partage), undefined);
});

test('adresses : ajout, liste, suppression', async () => {
  const a = await alice.req('POST', '/adresses', { nom_complet: 'Alice A', ligne1: '1 rue des Fleurs', code_postal: '75001', ville: 'Paris' });
  assert.equal(a.statut, 201);
  assert.equal((await alice.req('POST', '/adresses', { nom_complet: 'X', ligne1: '1', code_postal: '<script>', ville: 'Y' })).statut, 400);
  assert.equal((await alice.req('GET', '/adresses')).json.length, 1);
  assert.equal((await alice.req('DELETE', `/adresses/${a.json.id}`)).statut, 200);
});

// ------------------------------------------------------------------ admin : commandes et échéances

const admin = new Client('/api/v1');
let commandeId;

test('admin : commande payée -> rappels de validation ; validation -> 4 rappels d\'envoi', async () => {
  const a = await admin.req('POST', '/auth/login', { email: 'admin@test.local', motdepasse: 'mot-de-passe-de-test!' });
  admin.csrf = a.json.csrf;
  const b = await admin.req('POST', '/auth/2fa', { code: S.codeTotp(totpAdmin, Math.floor(Date.now() / 30000)) });
  admin.csrf = b.json.csrf;

  const devisId = srv.db.prepare('SELECT id FROM devis ORDER BY id LIMIT 1').get().id;
  for (let i = 0; i < 200 && srv.db.prepare('SELECT statut FROM devis WHERE id = ?').get(devisId).statut !== 'pret'; i++) {
    await new Promise((r) => setTimeout(r, 50));       // découpe du devis par la file Orca
  }
  assert.equal(srv.db.prepare('SELECT statut FROM devis WHERE id = ?').get(devisId).statut, 'pret');
  const clientId = srv.db.prepare('SELECT id FROM clients WHERE email = ?').get('alice@test.local').id;
  commandeId = Number(srv.db.prepare(`INSERT INTO commandes (client_id, devis_id, livraison_nom, livraison_adresse, sous_total_cts,
    livraison_cts, total_cts, cree_le) VALUES (?, ?, 'Alice', '{"ville":"Paris"}', 1000, 500, 1500, ?)`).run(clientId, devisId, Date.now()).lastInsertRowid);
  assert.equal(srv.app.locals.boutique.marquerPayee(commandeId, 'pi_test'), true);
  assert.equal(srv.db.prepare("SELECT count(*) n FROM rappels WHERE commande_id = ? AND echeance = 'validation'").get(commandeId).n, 2);
  const f = srv.db.prepare('SELECT * FROM fichiers_stl WHERE id = ?').get(fichierId);
  assert.equal(f.expire_le - f.cree_le, 730 * JOUR, 'STL commandé gardé 2 ans');

  const liste = await admin.req('GET', '/boutique/commandes?statut=payee');
  assert.equal(liste.json.length, 1);
  assert.equal(liste.json[0].client.email, 'alice@test.local');
  assert.equal((await admin.req('POST', `/boutique/commandes/${commandeId}/valider`)).statut, 200);
  const c = srv.db.prepare('SELECT * FROM commandes WHERE id = ?').get(commandeId);
  assert.equal(c.statut, 'validee');
  assert.equal(c.envoi_limite_le - c.valide_le, 60 * JOUR);
  const r = srv.db.prepare('SELECT echeance, palier FROM rappels WHERE commande_id = ? ORDER BY prevu_le').all(commandeId);
  assert.deepEqual(r.map((x) => `${x.echeance}:${x.palier}`), ['envoi:moitie', 'envoi:quart', 'envoi:j5', 'envoi:j2']);
  assert.equal((await admin.req('POST', `/boutique/commandes/${commandeId}/valider`)).statut, 409, 'déjà validée');
});

test('admin : refuser demande la 2FA, puis répond honnêtement que Stripe n\'est pas branché', async () => {
  // la connexion compte comme confirmation pendant 10 min : on la fait vieillir
  srv.db.prepare('UPDATE sessions SET dernier_2fa = 0').run();
  const r = await admin.req('POST', `/boutique/commandes/${commandeId}/refuser`, { motif: 'pièce dangereuse' });
  assert.equal(r.json.erreur, 'confirmation_requise');
  const pas = Math.floor(Date.now() / 30000) + 1;           // pas suivant : le code de connexion est déjà consommé
  assert.equal((await admin.req('POST', '/auth/2fa/confirmer', { code: S.codeTotp(totpAdmin, pas) })).statut, 200);
  const r2 = await admin.req('POST', `/boutique/commandes/${commandeId}/refuser`, { motif: 'pièce dangereuse' });
  assert.equal(r2.statut, 503);
  assert.equal(r2.json.erreur, 'paiement_non_configure');
  assert.equal(srv.db.prepare('SELECT statut FROM commandes WHERE id = ?').get(commandeId).statut, 'validee', 'rien n\'a changé');
});

test('admin : gcode découpé par le serveur pour les commandes payées, plus aucun STL, résumé', async () => {
  // plus aucun accès aux fichiers envoyés par les clients
  assert.equal((await admin.req('GET', '/boutique/stl?q=cube')).statut, 404);
  assert.equal((await admin.req('GET', `/boutique/stl/${fichierId}/fichier`)).statut, 404);

  const devisId = srv.db.prepare('SELECT devis_id FROM commandes WHERE id = ?').get(commandeId).devis_id;
  const g = await admin.req('GET', `/boutique/commandes/${commandeId}/gcode`);
  assert.equal(g.statut, 200);
  assert.match(g.res.headers.get('content-disposition'), /commande-\d+\.gcode/);
  assert.equal(await g.res.text(), gcodeDuDevis(devisId));
  const meta = await admin.req('GET', `/boutique/commandes/${commandeId}/gcode/toolpath`);
  assert.equal(meta.json.layers.length, 3);
  const bin = await admin.req('GET', `/boutique/commandes/${commandeId}/gcode/toolpath-bin`);
  assert.equal((await bin.res.arrayBuffer()).byteLength, meta.json.segments * 9);

  // commande pas payée : pas de gcode
  const autreDevis = srv.db.prepare("SELECT id FROM devis WHERE statut = 'pret' AND id != ? AND id NOT IN (SELECT devis_id FROM commandes) LIMIT 1").get(devisId).id;
  const impayee = srv.db.prepare(`INSERT INTO commandes (client_id, devis_id, livraison_nom, livraison_adresse, sous_total_cts,
    livraison_cts, total_cts, cree_le) SELECT client_id, id, 'X', '{}', 1, 1, 2, ? FROM devis WHERE id = ?`).run(Date.now(), autreDevis).lastInsertRowid;
  assert.equal((await admin.req('GET', `/boutique/commandes/${impayee}/gcode`)).json.erreur, 'commande_non_payee');
  srv.db.prepare('DELETE FROM commandes WHERE id = ?').run(impayee);

  const res = await admin.req('GET', '/boutique/resume');
  assert.equal(res.json.commandes.validee, 1);
  assert.equal(res.json.paiement_configure, false);
});

test('tâche horaire : rappels dus envoyés aux admins, STL expirés supprimés, remboursement auto en attente de Stripe', async () => {
  const B = srv.app.locals.boutique;
  const plusTard = Date.now() + 61 * JOUR;
  const bilan = await B.tacheHoraire(plusTard);
  assert.ok(bilan.rappels >= 1);
  assert.ok(boite.some((m) => m.a === 'admin@test.local' && /Rappel : commande/.test(m.sujet)));
  assert.equal(bilan.remboursees, 0, 'Stripe pas branché : rien de remboursé');
  assert.equal(srv.db.prepare('SELECT statut FROM commandes WHERE id = ?').get(commandeId).statut, 'validee');
  // le STL commandé (2 ans) reste, le gros cube jamais commandé (30 jours) part
  assert.ok(srv.db.prepare("SELECT chemin FROM fichiers_stl WHERE id = ?").get(fichierId).chemin);
  assert.equal(srv.db.prepare("SELECT count(*) n FROM fichiers_stl WHERE nom_origine = 'gros.stl'").get().n, 0);
});
