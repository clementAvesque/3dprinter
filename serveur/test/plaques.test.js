'use strict';
// Plaques (src/plaques.js) avec un faux agent : validation d'une commande -> plaque dans « a_faire/ »,
// suivi de l'impression d'après l'état de l'imprimante, pop-up (à valider), ratée / relance, rangement.
//   npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { ouvrir } = require('../src/db');
const { creerPlaques, dateParis } = require('../src/plaques');

const GCODE = '; plaque de test\nG1 X10 Y10 E1\n';
let dossier, db, hub, plaques, imprimees;

// faux agent : enregistre les commandes, reçoit les fichiers, état d'impression réglable
function fauxHub() {
  const h = new EventEmitter();
  h.lien = {};
  h.appels = [];
  h.etat = { print: { state: 'READY', etat_klipper: 'standby', filename: null } };
  h.fichiers = null;                                     // liste des fichiers de l'imprimante (null : inconnue)
  h.machine = (id) => (id === 'kobra-1' ? { id, enLigne: true, etat: h.etat, fichiers: h.fichiers } : undefined);
  h.envoyerFichier = async (c, chemin) => { h.recu = fs.readFileSync(chemin, 'utf8'); };
  h.rafraichirFichiers = async () => {
    if (h.fichiers) await plaques.surEtat({ machine: 'kobra-1', nom: 'fichiers', donnees: { liste: h.fichiers } });
    return { ok: true };
  };
  h.commande = async (machine, action, params, opts = {}) => {
    h.appels.push({ machine, action, params });
    if (h.refuser === action) return { ok: false, erreur: 'refusee', detail: 'test' };
    if (opts.envoi) await opts.envoi({});
    return { ok: true, resultat: null };
  };
  // l'imprimante envoie son état (comme l'agent toutes les 2 s)
  h.imprime = async (state, klipper, filename) => {
    h.etat.print = { state, etat_klipper: klipper, filename };
    await plaques.surEtat({ machine: 'kobra-1', nom: 'etat', donnees: h.etat });
  };
  return h;
}

const now = Date.now();
let clientId = 0;
function commandeValidee(nom, nbDevis = 1) {
  clientId = Number(db.prepare('INSERT INTO clients (email, hash, nom, cree_le) VALUES (?, ?, ?, ?)').run(`${crypto.randomUUID()}@t`, 'x', nom, now).lastInsertRowid);
  const ids = [];
  for (let i = 0; i < nbDevis; i++) {
    const rel = `gcode/test-${crypto.randomUUID()}.gcode.gz`;
    fs.mkdirSync(path.join(dossier, 'gcode'), { recursive: true });
    fs.writeFileSync(path.join(dossier, rel), zlib.gzipSync(GCODE));
    const f = db.prepare(`INSERT INTO fichiers_stl (client_id, nom_origine, chemin, taille_octets, sha256, triangles, dim_x_mm, dim_y_mm,
      dim_z_mm, cree_le, expire_le) VALUES (?, ?, 'stl/x.gz', 1, 'x', 12, 20, 20, 20, ?, ?)`).run(clientId, `piece-${i + 1}.stl`, now, now + 1e9).lastInsertRowid;
    const d = Number(db.prepare(`INSERT INTO devis (client_id, imprimante_id, remplissage_pct, couches_surface, proprete_mm, statut, gcode_chemin,
      poids_g, duree_s, prix_matiere_cts, livraison_cts, cree_le) VALUES (?, 'kobra-1', 15, 3, 0.2, 'pret', ?, 10, 600, 200, 500, ?)`)
      .run(clientId, rel, now).lastInsertRowid);
    db.prepare('INSERT INTO devis_pieces (devis_id, fichier_id, quantite, echelle) VALUES (?, ?, 2, 1)').run(d, f);
    ids.push(d);
  }
  const c = Number(db.prepare(`INSERT INTO commandes (client_id, devis_id, statut, livraison_nom, livraison_adresse, sous_total_cts,
    livraison_cts, total_cts, cree_le) VALUES (?, ?, 'validee', ?, '{}', 200, 500, 700, ?)`).run(clientId, ids[0], nom, now).lastInsertRowid);
  for (const d of ids.slice(1)) db.prepare('INSERT INTO commande_devis (commande_id, devis_id) VALUES (?, ?)').run(c, d);
  return c;
}
const statutCommande = (id) => db.prepare('SELECT statut FROM commandes WHERE id = ?').get(id).statut;
const plaque = (id) => db.prepare('SELECT * FROM lots WHERE id = ?').get(id);
const attendre = async (cond) => { for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); };

before(() => {
  dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'plaques-test-'));
  db = ouvrir(dossier);
  hub = fauxHub();
  imprimees = [];
  plaques = creerPlaques({ config: { donnees: dossier }, db, hub, journal: () => {}, quandImprimee: async (c) => { imprimees.push(c.id); } });
});
after(async () => {
  await plaques.arreter();
  db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
});

let c1, p1;

test('validation d\'une commande : une plaque, envoyée dans « a_faire/ » sur l\'imprimante', async () => {
  c1 = commandeValidee('Clément Avesque');
  [p1] = plaques.creerPourCommande(c1);
  await attendre(() => plaque(p1).statut === 'a_faire');
  const l = plaque(p1);
  assert.equal(l.statut, 'a_faire');
  assert.equal(l.fichier_machine, `a_faire/P${String(p1).padStart(4, '0')}_${dateParis(Date.now()).jour}.gcode`);
  const envoi = hub.appels.find((a) => a.action === 'file.upload');
  assert.equal(envoi.params.fichier, l.fichier_machine);
  assert.equal(hub.recu, GCODE, 'gcode décompressé, identique');
  assert.equal(envoi.params.sha256, crypto.createHash('sha256').update(GCODE).digest('hex'));
  assert.equal(statutCommande(c1), 'dans_un_lot', 'commande : en attente d\'impression');
  assert.deepEqual(plaques.creerPourCommande(c1), [], 'pas de doublon');
  // fiche de tri
  const [bloc] = plaques.contenu(p1);
  assert.equal(bloc.client_nom, 'Clément Avesque');
  assert.deepEqual(bloc.pieces.map((p) => `${p.nom} x${p.quantite}`), ['piece-1.stl x2']);
});

test('suivi : lancée (même depuis l\'écran) -> en impression ; finie -> imprimée, à valider', async () => {
  await hub.imprime('PRINTING', 'printing', 'autre-fichier.gcode');
  assert.equal(plaque(p1).statut, 'a_faire', 'un autre fichier ne la touche pas');
  await hub.imprime('PRINTING', 'printing', plaque(p1).fichier_machine);
  assert.equal(plaque(p1).statut, 'en_impression');
  assert.equal(plaque(p1).tentatives, 1);
  assert.equal(statutCommande(c1), 'en_impression');
  await hub.imprime('READY', 'complete', plaque(p1).fichier_machine);
  assert.equal(plaque(p1).statut, 'imprimee');
  assert.equal(statutCommande(c1), 'en_impression', 'pas encore validée');
});

test('ratée : retour dans « a_faire », relance proposée si la machine est libre ; annulée -> à refaire', async () => {
  const r = await plaques.rater(p1);
  assert.equal(r.statut, 'a_faire');
  assert.equal(r.relancable, true);
  assert.equal(statutCommande(c1), 'dans_un_lot');

  hub.etat.print = { state: 'PRINTING', etat_klipper: 'printing', filename: 'autre.gcode' };
  await assert.rejects(plaques.lancer(p1, 'admin'), (e) => e.code === 'machine_occupee');
  hub.etat.print = { state: 'READY', etat_klipper: 'standby', filename: null };
  await plaques.lancer(p1, 'admin');
  assert.deepEqual(hub.appels.at(-1), { machine: 'kobra-1', action: 'print.start', params: { fichier: plaque(p1).fichier_machine } });

  await hub.imprime('PRINTING', 'printing', plaque(p1).fichier_machine);
  await hub.imprime('READY', 'cancelled', plaque(p1).fichier_machine);
  assert.equal(plaque(p1).statut, 'a_faire', 'annulée sur l\'imprimante : à refaire');
  assert.equal(plaque(p1).tentatives, 2);
});

test('validée : rangée dans « imprimees/ » (numéro, date, heure, client), commande imprimée, client prévenu', async () => {
  await hub.imprime('PRINTING', 'printing', plaque(p1).fichier_machine);
  await hub.imprime('READY', 'complete', plaque(p1).fichier_machine);
  const source = plaque(p1).fichier_machine;
  const r = await plaques.valider(p1, null);
  assert.equal(r.statut, 'validee');
  assert.equal(r.range, true);
  const move = hub.appels.find((a) => a.action === 'file.move');
  assert.equal(move.params.source, source);
  assert.match(move.params.destination, new RegExp(`^imprimees/P${String(p1).padStart(4, '0')}_\\d{4}-\\d{2}-\\d{2}_\\d{2}h\\d{2}_Clement-Avesque\\.gcode$`));
  assert.equal(plaque(p1).fichier_machine, move.params.destination);
  assert.equal(statutCommande(c1), 'imprimee');
  assert.deepEqual(imprimees, [c1]);
  await assert.rejects(plaques.valider(p1, null), (e) => e.code === 'statut_incompatible');
});

test('commande groupée : imprimée seulement quand toutes ses plaques sont validées ; agent absent : rangement différé', async () => {
  const c = commandeValidee('Bob Martin', 2);
  const [a, b] = plaques.creerPourCommande(c);
  await attendre(() => plaque(b)?.statut === 'a_faire');
  for (const id of [a, b]) {
    await hub.imprime('PRINTING', 'printing', plaque(id).fichier_machine);
    await hub.imprime('READY', 'complete', plaque(id).fichier_machine);
  }
  await plaques.valider(a, null);
  assert.equal(statutCommande(c), 'en_impression', 'une plaque sur deux');

  hub.lien = null;                                       // Raspberry déconnecté
  const r = await plaques.valider(b, null);
  assert.equal(r.range, false);
  assert.match(plaque(b).rangement, /^imprimees\/.*_Bob-Martin\.gcode$/);
  assert.equal(statutCommande(c), 'imprimee');
  hub.lien = {};
  await plaques.travail();
  assert.equal(plaque(b).rangement, null, 'rangé au retour de l\'agent');
  assert.match(plaque(b).fichier_machine, /^imprimees\//);
});

test('fichier absent de l\'imprimante : renvoyé au lancement, et dès que la liste des fichiers le montre', async () => {
  const c = commandeValidee('Dany');
  const [p] = plaques.creerPourCommande(c);
  await attendre(() => plaque(p).statut === 'a_faire');
  const envois = () => hub.appels.filter((a) => a.action === 'file.upload' && a.params.fichier === plaque(p).fichier_machine).length;
  assert.equal(envois(), 1);

  // envoyée à un ancien agent qui l'a rangée ailleurs : « Lancer » la renvoie puis lance
  hub.fichiers = [{ nom: 'P0042.gcode' }];
  await plaques.lancer(p, 'admin');
  assert.equal(envois(), 2, 'renvoyée');
  assert.equal(plaque(p).statut, 'a_faire');
  assert.deepEqual(hub.appels.at(-1), { machine: 'kobra-1', action: 'print.start', params: { fichier: plaque(p).fichier_machine } });

  // liste reçue sans le fichier (envoyé il y a plus d'une minute) : renvoyée toute seule
  db.prepare('UPDATE lots SET envoye_le = ? WHERE id = ?').run(Date.now() - 120e3, p);
  await plaques.surEtat({ machine: 'kobra-1', nom: 'fichiers', donnees: { liste: [] } });
  assert.equal(plaque(p).statut, 'a_envoyer');
  await attendre(() => plaque(p).statut === 'a_faire');
  assert.equal(envois(), 3);
  // présent dans la liste : rien ne bouge
  db.prepare('UPDATE lots SET envoye_le = ? WHERE id = ?').run(Date.now() - 120e3, p);
  await plaques.surEtat({ machine: 'kobra-1', nom: 'fichiers', donnees: { liste: [{ nom: plaque(p).fichier_machine }] } });
  assert.equal(plaque(p).statut, 'a_faire');
  hub.fichiers = null;
});

test('nom déjà pris sur l\'imprimante (base nettoyée, numéros repartis de 1) : suffixe -2, rien d\'écrasé', async () => {
  const c = commandeValidee('Eve');
  const [p] = plaques.creerPourCommande(c);
  const attendu = `a_faire/P${String(p).padStart(4, '0')}_${dateParis(Date.now()).jour}`;
  hub.fichiers = [{ nom: `${attendu}.gcode` }];
  await attendre(() => plaque(p).statut === 'a_faire');
  assert.equal(plaque(p).fichier_machine, `${attendu}-2.gcode`);
  hub.fichiers = null;
});

test('commande remboursée : ses plaques pas encore imprimées sont annulées', async () => {
  const c = commandeValidee('Carole');
  hub.lien = null;                                       // pas d'envoi : la plaque reste « a_envoyer »
  const [p] = plaques.creerPourCommande(c);
  assert.equal(plaque(p).statut, 'a_envoyer');
  plaques.annulerPourCommande(c);
  assert.equal(plaque(p).statut, 'annulee');
  hub.lien = {};
});
