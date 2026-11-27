'use strict';
// Tests du paiement Stripe avec un faux Stripe local (aucun appel au vrai Stripe) :
// commande -> page de paiement, webhook signé -> payée + facture, anomalies, rejeu, expiration, remboursement.
//   npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { genererPki } = require('../scripts/pki');
const { charger } = require('../src/config');
const { demarrer } = require('../src/index');
const { formulaire } = require('../src/paiements');
const S = require('../src/securite');

const SECRET = 'whsec_test_secret';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stripe-test-'));
let srv, base, boite, stripe, totpAdmin;

// ------------------------------------------------------------------ faux Stripe

function fauxStripe() {
  const appels = [];
  let n = 0;
  const serveur = http.createServer((req, res) => {
    let corps = '';
    req.on('data', (d) => { corps += d; });
    req.on('end', () => {
      const params = Object.fromEntries(new URLSearchParams(corps));
      appels.push({ chemin: req.url, auth: req.headers.authorization, params });
      res.setHeader('Content-Type', 'application/json');
      if (req.headers.authorization !== 'Bearer sk_test_faux') { res.statusCode = 401; return res.end('{"error":{"message":"clé"}}'); }
      if (req.url === '/v1/checkout/sessions') {
        n += 1;
        return res.end(JSON.stringify({ id: `cs_test_${n}`, url: `https://checkout.stripe.test/cs_test_${n}` }));
      }
      if (/^\/v1\/checkout\/sessions\/[^/]+\/expire$/.test(req.url)) return res.end('{"status":"expired"}');
      if (req.url === '/v1/refunds') return res.end('{"id":"re_1","status":"succeeded"}');
      res.statusCode = 404;
      res.end('{"error":{"message":"inconnu"}}');
    });
  });
  return { serveur, appels };
}

// webhook signé comme Stripe : en-tête « t=<horodatage>,v1=<HMAC SHA-256 de "t.corps"> »
function signer(corps, t = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${corps}`).digest('hex')}`;
}
async function webhook(ev, entete) {
  const corps = JSON.stringify(ev);
  const r = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', body: corps,
    headers: { 'content-type': 'application/json', 'stripe-signature': entete ?? signer(corps) } });
  return { statut: r.status, json: await r.json() };
}
let numEv = 0;
const evenement = (type, objet) => ({ id: `evt_${++numEv}`, type, data: { object: objet } });
const sessionPayee = (c, autres = {}) => evenement('checkout.session.completed', { id: c.stripe_session_id, payment_status: 'paid',
  amount_total: c.total_cts, currency: 'eur', payment_intent: `pi_${c.id}`, client_reference_id: String(c.id),
  metadata: { commande_id: String(c.id) }, ...autres });

// ------------------------------------------------------------------ client HTTP

class Client {
  constructor(prefixe = '/api/client') { this.prefixe = prefixe; this.cookie = ''; this.csrf = ''; }
  async req(methode, chemin, corps) {
    const h = {};
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf) h['x-csrf-token'] = this.csrf;
    if (corps !== undefined && !(corps instanceof FormData)) h['content-type'] = 'application/json';
    const res = await fetch(base + this.prefixe + chemin, { method: methode, headers: h,
      body: corps === undefined ? undefined : corps instanceof FormData ? corps : JSON.stringify(corps) });
    for (const c of res.headers.getSetCookie()) this.cookie = c.split(';')[0];
    const json = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    return { statut: res.status, json };
  }
}

function cube(c = 20) {
  const s = [[0, 0, 0], [c, 0, 0], [c, c, 0], [0, c, 0], [0, 0, c], [c, 0, c], [c, c, c], [0, c, c]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + faces.length * 50);
  buf.writeUInt32LE(faces.length, 80);
  faces.forEach((f, i) => f.forEach((v, k) => s[v].forEach((x, d) => buf.writeFloatLE(x, 84 + i * 50 + 12 + k * 12 + d * 4))));
  return buf;
}

async function clientVerifie(email) {
  const c = new Client();
  assert.equal((await c.req('POST', '/inscription', { email, motdepasse: 'un-mot-de-passe-solide', nom: 'Test' })).statut, 200);
  const m = [...boite].reverse().find((x) => x.a === email && x.texte.includes('/verifier'));
  const r = await c.req('POST', '/verifier', { jeton: m.texte.match(/verifier\?jeton=([A-Za-z0-9_-]+)/)[1] });
  c.csrf = r.json.csrf;
  return c;
}

// devis découpé (faux Orca) + adresse : prêt à commander
async function devisPret(c) {
  const fd = new FormData();
  fd.append('fichier', new Blob([cube()]), 'cube.stl');
  const f = await c.req('POST', '/fichiers', fd);
  const d = await c.req('POST', '/devis', { imprimante_id: 'kobra-1', reglages: { remplissage_pct: 15 },
    pieces: [{ fichier_id: f.json.id, quantite: 1 }] });
  for (let i = 0; i < 200; i++) {
    if ((await c.req('GET', `/devis/${d.json.id}`)).json.statut === 'pret') break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const a = await c.req('POST', '/adresses', { nom_complet: 'Alice Test', ligne1: '1 rue de la Paix', code_postal: '75002', ville: 'Paris' });
  return { devisId: d.json.id, adresseId: a.json.id };
}
// commande en base, par son UUID public (API) ou son numéro interne
const commande = (id) => srv.db.prepare('SELECT * FROM commandes WHERE uuid = ? OR id = ?').get(String(id), Number(id) || -1);
const interne = (table, uuid) => srv.db.prepare(`SELECT id FROM ${table} WHERE uuid = ?`).get(uuid)?.id;
const vueCommande = (c) => ({ id: c.uuid, ref: c.uuid.slice(0, 8).toUpperCase(), statut: c.statut });

before(async () => {
  stripe = fauxStripe();
  await new Promise((ok) => stripe.serveur.listen(0, '127.0.0.1', ok));
  genererPki({ fichiersServeur: { ca: path.join(dir, 'pki', 'ca.crt.pem'), cert: path.join(dir, 'pki', 'serveur.crt.pem'),
    cle: path.join(dir, 'pki', 'serveur.key.pem') }, dossierAgent: path.join(dir, 'agent'), agentId: 'agent-test', bits: 2048 });
  const fichierConfig = path.join(dir, 'config.json');
  fs.writeFileSync(fichierConfig, JSON.stringify({
    api: { port: 0, cookieSecure: false },
    agent: { port: 0, hote: '127.0.0.1', id: 'agent-test' },
    pki: { ca: path.join(dir, 'pki', 'ca.crt.pem'), cert: path.join(dir, 'pki', 'serveur.crt.pem'), cle: path.join(dir, 'pki', 'serveur.key.pem') },
    donnees: path.join(dir, 'data'),
    siteClient: '',
    boutique: { urlSite: 'https://boutique.test', courriel: { mode: 'memoire' } },
    orca: { commande: [process.execPath, path.join(__dirname, 'faux-orca.js')], intervalleMs: 100 },
    stripe: { cleSecrete: 'sk_test_faux', secretWebhook: SECRET, api: `http://127.0.0.1:${stripe.serveur.address().port}` },
  }));
  srv = await demarrer(charger(fichierConfig));
  base = `http://127.0.0.1:${srv.serveurApi.address().port}`;
  boite = srv.app.locals.courriel.boite;
  totpAdmin = S.nouveauSecretTotp();
  srv.db.prepare('INSERT INTO utilisateurs (email, nom, role, hash, totp_secret, cree) VALUES (?, ?, ?, ?, ?, ?)')
    .run('admin@test.local', 'Admin', 'admin', await S.hacher('mot-de-passe-de-test!'), totpAdmin, Date.now());
});

after(async () => {
  await srv.arreter();
  stripe.serveur.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ tests

test('formulaire Stripe : objets et listes imbriqués', () => {
  assert.equal(formulaire({ a: 1, b: { c: 'x y', d: [{ e: 2 }] }, z: undefined }), 'a=1&b%5Bc%5D=x%20y&b%5Bd%5D%5B0%5D%5Be%5D=2');
});

let alice, achat, commandeId;

test('commande : montant pris dans le devis, page de paiement Stripe, e-mail vérifié exigé', async () => {
  alice = await clientVerifie('alice@test.local');
  achat = await devisPret(alice);
  const d = (await alice.req('GET', `/devis/${achat.devisId}`)).json;
  assert.equal(d.statut, 'pret');
  assert.equal(d.commande, null);

  const r = await alice.req('POST', '/commandes', { devis_id: achat.devisId, adresse_id: achat.adresseId });
  assert.equal(r.statut, 201, JSON.stringify(r.json));
  assert.match(r.json.url, /^https:\/\/checkout\.stripe\.test\//);
  commandeId = r.json.commande_id;
  const c = commande(commandeId);
  assert.equal(c.statut, 'en_attente_paiement');
  assert.equal(c.total_cts, d.total_cts);
  assert.equal(c.stripe_session_id, 'cs_test_1');

  const appel = stripe.appels.find((a) => a.chemin === '/v1/checkout/sessions').params;
  assert.equal(appel['line_items[0][price_data][unit_amount]'], String(d.prix_matiere_cts));
  assert.equal(appel['line_items[1][price_data][unit_amount]'], String(d.livraison_cts));
  assert.equal(appel['line_items[0][price_data][currency]'], 'eur');
  assert.equal(appel.customer_email, 'alice@test.local');
  assert.match(commandeId, /^[0-9a-f-]{36}$/, 'le client reçoit l\'UUID de la commande, pas son numéro');
  assert.equal(appel['metadata[commande_id]'], String(c.id), 'Stripe garde le numéro interne (invisible du client)');
  assert.equal(appel['line_items[0][price_data][product_data][name]'], `Impression 3D · devis ${achat.devisId.slice(0, 8).toUpperCase()}`);
  assert.equal(appel.success_url, `https://boutique.test/merci?commande=${commandeId}`);
  assert.equal(appel.cancel_url, `https://boutique.test/devis/${achat.devisId}`);

  // champs inconnus (un prix envoyé par le navigateur, par ex.) refusés ; devis d'un autre : inconnu
  assert.equal((await alice.req('POST', '/commandes', { devis_id: achat.devisId, adresse_id: achat.adresseId, total_cts: 1 })).json.erreur, 'champ_inconnu');
  const bob = await clientVerifie('bob@test.local');
  assert.equal((await bob.req('POST', '/commandes', { devis_id: achat.devisId, adresse_id: achat.adresseId })).statut, 404);

  // e-mail pas encore confirmé : pas de commande
  const nv = new Client();
  await nv.req('POST', '/inscription', { email: 'nv@test.local', motdepasse: 'un-mot-de-passe-solide', nom: 'Nv' });
  nv.csrf = (await nv.req('POST', '/connexion', { email: 'nv@test.local', motdepasse: 'un-mot-de-passe-solide' })).json?.csrf || '';
  assert.notEqual((await nv.req('POST', '/commandes', { devis_id: achat.devisId, adresse_id: achat.adresseId })).statut, 201);
});

test('webhook : signature fausse, trop vieille ou absente -> refusé, rien ne change', async () => {
  const ev = sessionPayee(commande(commandeId));
  const corps = JSON.stringify(ev);
  assert.equal((await webhook(ev, signer(corps, undefined, 'whsec_autre'))).statut, 400);
  assert.equal((await webhook(ev, signer(corps, Math.floor(Date.now() / 1000) - 600))).statut, 400);
  assert.equal((await webhook(ev, '')).statut, 400);
  assert.equal(commande(commandeId).statut, 'en_attente_paiement');
});

test('webhook : montant ou session qui ne correspondent pas -> pas payée, admin prévenu', async () => {
  const c = commande(commandeId);
  assert.equal((await webhook(sessionPayee(c, { amount_total: 1 }))).statut, 200);
  assert.equal((await webhook(sessionPayee(c, { id: 'cs_autre' }))).statut, 200);
  assert.equal(commande(commandeId).statut, 'en_attente_paiement');
  assert.ok(boite.some((m) => m.a === 'admin@test.local' && /à vérifier/.test(m.sujet)));
});

test('webhook : paiement reçu -> payée, facture numérotée, e-mails ; un événement rejoué ne compte qu\'une fois', async () => {
  const ev = sessionPayee(commande(commandeId));
  assert.equal((await webhook(ev)).statut, 200);
  const c = commande(commandeId);
  assert.equal(c.statut, 'payee');
  assert.equal(c.stripe_paiement_id, `pi_${c.id}`);
  const f = srv.db.prepare('SELECT * FROM factures WHERE commande_id = ?').get(c.id);
  assert.equal(f.numero, `${new Date().getFullYear()}-000001`);
  assert.equal(f.total_cts, c.total_cts);
  assert.ok(boite.some((m) => m.a === 'alice@test.local' && /Paiement reçu/.test(m.sujet)));
  assert.ok(boite.some((m) => m.a === 'admin@test.local' && /Nouvelle commande payée/.test(m.sujet)));

  const avant = boite.length;
  assert.equal((await webhook(ev)).statut, 200, 'Stripe renvoie parfois le même événement');
  assert.equal(srv.db.prepare('SELECT count(*) n FROM factures').get().n, 1);
  assert.equal(boite.length, avant, 'pas d\'e-mail en double');

  // devis déjà payé : pas de seconde commande ; le devis montre la commande
  assert.equal((await alice.req('POST', '/commandes', { devis_id: achat.devisId, adresse_id: achat.adresseId })).json.erreur, 'deja_commandee');
  assert.deepEqual((await alice.req('GET', `/devis/${achat.devisId}`)).json.commande, vueCommande(commande(commandeId)));
  assert.equal((await alice.req('DELETE', `/devis/${achat.devisId}`)).json.erreur, 'devis_commande', 'devis payé : pas supprimable');
});

test('page de paiement expirée -> abandonnée ; nouvel essai : nouvelle commande, l\'ancienne page fermée chez Stripe', async () => {
  const a2 = await devisPret(alice);
  const r = await alice.req('POST', '/commandes', { devis_id: a2.devisId, adresse_id: a2.adresseId });
  const c = commande(r.json.commande_id);
  await webhook(evenement('checkout.session.expired', { id: c.stripe_session_id, metadata: { commande_id: String(c.id) } }));
  assert.equal(commande(c.id).statut, 'abandonnee');

  // nouvel essai alors qu'une page de paiement est encore ouverte : elle est fermée chez Stripe
  const r2 = await alice.req('POST', '/commandes', { devis_id: a2.devisId, adresse_id: a2.adresseId });
  assert.equal(r2.statut, 201);
  // (SQLite peut redonner le numéro d'une commande supprimée : on vérifie la session Stripe et le nombre de commandes)
  const c2 = commande(r2.json.commande_id);
  assert.equal(c2.statut, 'en_attente_paiement');
  assert.notEqual(c2.stripe_session_id, c.stripe_session_id);
  const nbCommandes = () => srv.db.prepare('SELECT count(*) n FROM commande_devis WHERE devis_id = ?').get(interne('devis', a2.devisId)).n;
  assert.equal(nbCommandes(), 1, 'l\'ancienne commande abandonnée est supprimée');
  const r3 = await alice.req('POST', '/commandes', { devis_id: a2.devisId, adresse_id: a2.adresseId });
  assert.equal(r3.statut, 201);
  assert.ok(stripe.appels.some((x) => x.chemin === `/v1/checkout/sessions/${c2.stripe_session_id}/expire`));
  const c3 = commande(r3.json.commande_id);
  assert.notEqual(c3.stripe_session_id, c2.stripe_session_id);
  assert.equal(nbCommandes(), 1);

  // paiement en cours : pas supprimable ; abandonné : supprimable, la commande jamais payée part avec lui
  assert.equal((await alice.req('DELETE', `/devis/${a2.devisId}`)).json.erreur, 'devis_commande');
  await webhook(evenement('checkout.session.expired', { id: c3.stripe_session_id, metadata: { commande_id: String(c3.id) } }));
  assert.equal((await alice.req('DELETE', `/devis/${a2.devisId}`)).statut, 200);
  assert.equal(commande(c3.id), undefined);
});

test('commande groupée : plusieurs devis, une seule livraison sur le poids total, une ligne Stripe par devis', async () => {
  const d1 = await devisPret(alice), d2 = await devisPret(alice), d3 = await devisPret(alice);
  const ids = [d1.devisId, d2.devisId, d3.devisId];

  // estimation : matière de chaque devis + une livraison (12,5 g x 3 = 37,5 g -> 5 €), économie affichée
  const e = await alice.req('GET', `/commandes/estimation?devis=${ids.join(',')}`);
  assert.equal(e.statut, 200, JSON.stringify(e.json));
  assert.equal(e.json.poids_g, 37.5);
  assert.equal(e.json.sous_total_cts, 750);
  assert.equal(e.json.livraison_cts, 500);
  assert.equal(e.json.total_cts, 1250);
  assert.equal(e.json.economie_livraison_cts, 1000, '3 livraisons séparées = 15 €');
  assert.equal(e.json.devis.length, 3);

  // refus : doublon, liste vide, trop de devis, devis d'un autre
  assert.equal((await alice.req('POST', '/commandes', { devis_ids: [ids[0], ids[0]], adresse_id: d1.adresseId })).json.erreur, 'devis_invalides');
  assert.equal((await alice.req('POST', '/commandes', { devis_ids: [], adresse_id: d1.adresseId })).json.erreur, 'devis_invalides');
  assert.equal((await alice.req('POST', '/commandes', { devis_ids: Array.from({ length: 6 }, () => crypto.randomUUID()), adresse_id: d1.adresseId })).json.erreur, 'devis_invalides', '5 devis au plus');
  assert.equal((await alice.req('POST', '/commandes', { devis_ids: [interne('devis', ids[0])], adresse_id: d1.adresseId })).json.erreur, 'devis_invalides', 'numéro interne refusé');
  const bob = new Client();
  bob.csrf = (await bob.req('POST', '/connexion', { email: 'bob@test.local', motdepasse: 'un-mot-de-passe-solide' })).json.csrf;
  assert.equal((await bob.req('GET', `/commandes/estimation?devis=${ids[0]}`)).statut, 404);

  const avant = stripe.appels.length;
  const r = await alice.req('POST', '/commandes', { devis_ids: ids, adresse_id: d1.adresseId });
  assert.equal(r.statut, 201, JSON.stringify(r.json));
  const c = commande(r.json.commande_id);
  assert.equal(c.total_cts, 1250);
  assert.equal(c.livraison_cts, 500);
  const appel = stripe.appels.slice(avant).find((a) => a.chemin === '/v1/checkout/sessions').params;
  assert.equal(appel['line_items[0][price_data][product_data][name]'], `Impression 3D · devis ${ids[0].slice(0, 8).toUpperCase()}`);
  assert.equal(appel['line_items[2][price_data][product_data][name]'], `Impression 3D · devis ${ids[2].slice(0, 8).toUpperCase()}`);
  assert.equal(appel['line_items[3][price_data][product_data][name]'], 'Livraison groupée (3 devis)');
  assert.equal(appel['line_items[3][price_data][unit_amount]'], '500');
  assert.equal(appel.cancel_url, 'https://boutique.test/compte');

  // payée : les 3 devis appartiennent à la commande ; aucun ne peut être recommandé seul
  assert.equal((await webhook(sessionPayee(c))).statut, 200);
  assert.equal(commande(c.id).statut, 'payee');
  const detail = (await alice.req('GET', `/commandes/${c.uuid}`)).json;
  assert.deepEqual(detail.devis_ids, ids);
  assert.equal(detail.devis_liste.length, 3);
  for (const id of ids) assert.deepEqual((await alice.req('GET', `/devis/${id}`)).json.commande, vueCommande(commande(c.id)));
  assert.equal((await alice.req('POST', '/commandes', { devis_id: ids[1], adresse_id: d1.adresseId })).json.erreur, 'deja_commandee');

  // admin : gcode de chaque devis de la commande ; un devis hors commande refusé
  const admin = new Client('/api/v1');
  admin.csrf = (await admin.req('POST', '/auth/login', { email: 'admin@test.local', motdepasse: 'mot-de-passe-de-test!' })).json.csrf;
  admin.csrf = (await admin.req('POST', '/auth/2fa', { code: S.codeTotp(totpAdmin, Math.floor(Date.now() / 30000)) })).json.csrf;
  const fiche = (await admin.req('GET', `/boutique/commandes/${c.id}`)).json;
  assert.equal(fiche.devis_liste.length, 3);
  for (const id of ids) {
    const n = interne('devis', id);                       // l'admin travaille avec les numéros internes
    const g = await fetch(`${base}/api/v1/boutique/commandes/${c.id}/devis/${n}/gcode`, { headers: { cookie: admin.cookie } });
    assert.equal(g.status, 200);
    assert.match(g.headers.get('content-disposition'), new RegExp(`commande-${c.id}-devis-${n}\\.gcode`));
  }
  assert.equal((await admin.req('GET', `/boutique/commandes/${c.id}/devis/${interne('devis', achat.devisId)}/gcode/toolpath`)).statut, 404);
  assert.equal((await admin.req('GET', '/boutique/commandes?statut=payee')).json.find((x) => x.id === c.id).nb_pieces, 3);
});

test('admin : refuser une commande payée -> remboursement Stripe réel (faux Stripe), client prévenu', async () => {
  const admin = new Client('/api/v1');
  const a = await admin.req('POST', '/auth/login', { email: 'admin@test.local', motdepasse: 'mot-de-passe-de-test!' });
  admin.csrf = a.json.csrf;
  admin.csrf = (await admin.req('POST', '/auth/2fa', { code: S.codeTotp(totpAdmin, Math.floor(Date.now() / 30000) + 1) })).json.csrf;   // code du pas courant déjà utilisé
  assert.equal((await admin.req('GET', '/boutique/resume')).json.paiement_mode, 'test');

  const r = await admin.req('POST', `/boutique/commandes/${commande(commandeId).id}/refuser`, { motif: 'pièce dangereuse' });
  assert.equal(r.statut, 200, JSON.stringify(r.json));
  const c = commande(commandeId);
  assert.equal(c.statut, 'remboursee');
  const remb = stripe.appels.find((x) => x.chemin === '/v1/refunds');
  assert.equal(remb.params.payment_intent, `pi_${c.id}`);
  assert.ok(boite.some((m) => m.a === 'alice@test.local' && /remboursée/.test(m.sujet)));
});
