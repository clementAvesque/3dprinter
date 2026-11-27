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

test('validation pièce par pièce : les exemplaires ratés partent sur une plaque de reprise (redécoupée), même commande', async () => {
  const c = commandeValidee('Fanny Durand');
  // gcode comme celui d'Orca : un objet par exemplaire (2 exemplaires de piece-1), avec contour
  const devisId = db.prepare('SELECT devis_id FROM commandes WHERE id = ?').get(c).devis_id;
  const gz = db.prepare('SELECT gcode_chemin FROM devis WHERE id = ?').get(devisId).gcode_chemin;
  fs.writeFileSync(path.join(dossier, gz), zlib.gzipSync('; Orca\n'
    + 'EXCLUDE_OBJECT_DEFINE NAME=piece-1.stl_id_0_copy_0 CENTER=100,120 POLYGON=[[90,110],[110,110],[110,130],[90,130]]\n'
    + 'EXCLUDE_OBJECT_DEFINE NAME=piece-1.stl_id_1_copy_0 CENTER=140,120 POLYGON=[[130,110],[150,110],[150,130],[130,130]]\n'
    + 'G90\n;LAYER_CHANGE\nG1 X10 Y10 E1\n'));
  const [p] = plaques.creerPourCommande(c);
  await attendre(() => plaque(p).statut === 'a_faire');
  await hub.imprime('PRINTING', 'printing', plaque(p).fichier_machine);
  await hub.imprime('READY', 'complete', plaque(p).fichier_machine);

  const o = await plaques.objets(p);
  assert.deepEqual(o.plateau_mm, [250, 250]);
  assert.deepEqual(o.objets.map((x) => [x.nom, x.piece_nom, x.exemplaire, x.client_nom, x.centre]), [
    ['piece-1.stl_id_0_copy_0', 'piece-1.stl', 1, 'Fanny Durand', [100, 120]],
    ['piece-1.stl_id_1_copy_0', 'piece-1.stl', 2, 'Fanny Durand', [140, 120]]]);
  assert.equal(o.objets[0].polygone.length, 4);

  await assert.rejects(plaques.valider(p, null, []), (e) => e.code === 'aucune_piece');
  await assert.rejects(plaques.valider(p, null, ['inconnu']), (e) => e.code === 'objet_inconnu');

  // 1 exemplaire sur 2 réussi : plaque validée, l'autre part en reprise (devis interne à découper)
  const r = await plaques.valider(p, null, ['piece-1.stl_id_0_copy_0']);
  assert.equal(r.statut, 'validee');
  const reprise = db.prepare('SELECT * FROM lots WHERE reprise_de = ?').get(p);
  assert.equal(r.reprise, `P${String(reprise.id).padStart(4, '0')}`);
  assert.equal(reprise.statut, 'a_envoyer');
  assert.equal(reprise.gcode_chemin, null, 'en attente de la découpe');
  assert.deepEqual(r.reprises, [r.reprise]);
  const interne = db.prepare('SELECT * FROM devis WHERE id = ?').get(reprise.devis_reprise_id);
  assert.equal(interne.reprise, 1);
  assert.equal(interne.statut, 'attente');
  const pieceOrigine = db.prepare('SELECT id FROM devis_pieces WHERE devis_id = ?').get(devisId).id;
  assert.deepEqual({ ...db.prepare('SELECT quantite, origine_id FROM devis_pieces WHERE devis_id = ?').get(interne.id) },
    { quantite: 1, origine_id: pieceOrigine });
  assert.deepEqual({ ...db.prepare('SELECT devis_piece_id, quantite FROM lot_pieces WHERE lot_id = ?').get(reprise.id) },
    { devis_piece_id: pieceOrigine, quantite: 1 }, 'la reprise reprend la pièce d\'origine (même commande)');
  assert.equal(db.prepare('SELECT ratees FROM lot_pieces WHERE lot_id = ?').get(p).ratees, 1);
  assert.equal(plaques.contenu(reprise.id)[0].client_nom, 'Fanny Durand', 'fiche de tri de la reprise');
  assert.equal(statutCommande(c), 'en_impression', 'pas « imprimée » tant que la reprise n\'est pas faite');
  assert.ok(!imprimees.includes(c));

  // découpe faite (Orca) : gcode rattaché, plaque envoyée dans « a_faire/ »
  db.prepare("UPDATE devis SET statut = 'pret', gcode_chemin = ?, duree_s = 300 WHERE id = ?").run(gz, interne.id);
  plaques.rattacherReprises();
  await plaques.travail();
  assert.equal(plaque(reprise.id).statut, 'a_faire');
  assert.match(plaque(reprise.id).fichier_machine, /^a_faire\/P\d{4}_/);

  // reprise imprimée et validée : la commande est imprimée, le client prévenu
  await hub.imprime('PRINTING', 'printing', plaque(reprise.id).fichier_machine);
  await hub.imprime('READY', 'complete', plaque(reprise.id).fichier_machine);
  await plaques.valider(reprise.id, null);
  assert.equal(statutCommande(c), 'imprimee');
  assert.ok(imprimees.includes(c));
});

test('réimpression choisie : les exemplaires cochés partent sur une nouvelle plaque, la plaque de départ ne bouge pas', async () => {
  const c = commandeValidee('Marilou Milhamont');
  const devisId = db.prepare('SELECT devis_id FROM commandes WHERE id = ?').get(c).devis_id;
  const gz = db.prepare('SELECT gcode_chemin FROM devis WHERE id = ?').get(devisId).gcode_chemin;
  fs.writeFileSync(path.join(dossier, gz), zlib.gzipSync('; Orca\n'
    + 'EXCLUDE_OBJECT_DEFINE NAME=piece-1.stl_id_0_copy_0 CENTER=100,120 POLYGON=[[90,110],[110,110],[110,130],[90,130]]\n'
    + 'EXCLUDE_OBJECT_DEFINE NAME=piece-1.stl_id_1_copy_0 CENTER=140,120 POLYGON=[[130,110],[150,110],[150,130],[130,130]]\n'
    + 'G90\n;LAYER_CHANGE\nG1 X10 Y10 E1\n'));
  const [p] = plaques.creerPourCommande(c);
  await attendre(() => plaque(p).statut === 'a_faire');

  await assert.rejects(plaques.refaire(p, []), (e) => e.code === 'aucune_piece');
  await assert.rejects(plaques.refaire(p, ['inconnu']), (e) => e.code === 'objet_inconnu');
  await assert.rejects(plaques.refaire(p, 'piece-1.stl_id_0_copy_0'), (e) => e.code === 'objets_invalides');

  // les 2 exemplaires cochés : nouvelle plaque, même pièce d'origine en 2 exemplaires
  const r = await plaques.refaire(p, ['piece-1.stl_id_0_copy_0', 'piece-1.stl_id_1_copy_0']);
  assert.equal(r.pieces, 2);
  const nouvelle = db.prepare('SELECT * FROM lots WHERE reprise_de = ?').get(p);
  assert.equal(r.reprise, `P${String(nouvelle.id).padStart(4, '0')}`);
  assert.equal(nouvelle.statut, 'a_envoyer');
  assert.equal(nouvelle.gcode_chemin, null, 'en attente de la découpe');
  const interne = db.prepare('SELECT * FROM devis WHERE id = ?').get(nouvelle.devis_reprise_id);
  assert.equal(interne.reprise, 1);
  const pieceOrigine = db.prepare('SELECT id FROM devis_pieces WHERE devis_id = ?').get(devisId).id;
  assert.deepEqual({ ...db.prepare('SELECT quantite, origine_id FROM devis_pieces WHERE devis_id = ?').get(interne.id) },
    { quantite: 2, origine_id: pieceOrigine });
  assert.equal(plaques.contenu(nouvelle.id)[0].client_nom, 'Marilou Milhamont', 'fiche de tri de la nouvelle plaque');
  // contrairement à la validation pièce par pièce, la plaque de départ n'est pas touchée
  assert.equal(db.prepare('SELECT ratees FROM lot_pieces WHERE lot_id = ?').get(p).ratees, 0, 'aucun exemplaire marqué raté');
  assert.equal(plaque(p).statut, 'a_faire');
});

test('aperçu 3D : le STL rendu appartient bien à la plaque, les autres pièces sont refusées', async () => {
  const c = commandeValidee('Sacha Petit');
  const [p] = plaques.creerPourCommande(c);
  await attendre(() => plaque(p).statut === 'a_faire');
  const devisId = db.prepare('SELECT devis_id FROM commandes WHERE id = ?').get(c).devis_id;
  const piece = db.prepare('SELECT * FROM devis_pieces WHERE devis_id = ?').get(devisId);

  const f = plaques.stlDePiece(p, piece.id);
  assert.equal(f.nom, 'piece-1.stl');
  assert.equal(f.chemin, path.join(dossier, 'stl', 'x.gz'));

  // une pièce qui est sur une autre plaque (ou qui n'existe pas) : rien à montrer
  assert.throws(() => plaques.stlDePiece(p, piece.id + 1000), (e) => e.code === 'piece_inconnue');

  // droit à l'effacement : la ligne reste pour l'historique, le fichier non
  db.prepare("UPDATE fichiers_stl SET chemin = '' WHERE id = ?").run(piece.fichier_id);
  assert.throws(() => plaques.stlDePiece(p, piece.id), (e) => e.code === 'fichier_supprime');
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

test('fichiers de plaques supprimées ou annulées : retirés par l\'agent (imprimante + index), rien d\'autre', async () => {
  const c = commandeValidee('Gaston');
  const [p] = plaques.creerPourCommande(c);
  await attendre(() => plaque(p).statut === 'a_faire');
  const vivant = plaque(p).fichier_machine;
  const suppressions = () => hub.appels.filter((a) => a.action === 'file.delete').map((a) => a.params.fichier);
  const avant = suppressions().length;

  // plaque effacée de la base (P9999) : son fichier part ; le reste ne bouge pas
  hub.etat.print = { state: 'PRINTING', etat_klipper: 'printing', filename: 'a_faire/P9997_2026-11-27.gcode' };
  await plaques.surEtat({ machine: 'kobra-1', nom: 'fichiers', donnees: { liste: [
    { nom: vivant },                                     // plaque vivante
    { nom: 'a_faire/P9999_2026-11-27.gcode' },           // plaque supprimée : orpheline
    { nom: 'a_faire/P9997_2026-11-27.gcode' },           // orpheline, mais en cours d'impression
    { nom: 'a_faire/taquet-P0006.gcode' },               // pas un nom de plaque
    { nom: 'imprimees/P9998_2026-11-27_10h00_X.gcode' }, // autre dossier (archive)
    { nom: 'P9996_2026-11-27.gcode' },                   // à la racine
  ] } });
  hub.etat.print = { state: 'READY', etat_klipper: 'standby', filename: null };
  assert.deepEqual(suppressions().slice(avant), ['a_faire/P9999_2026-11-27.gcode']);

  // commande remboursée : la plaque déjà envoyée est annulée et son fichier retiré tout de suite
  hub.fichiers = [{ nom: vivant }];
  plaques.annulerPourCommande(c);
  assert.equal(plaque(p).statut, 'annulee');
  await attendre(() => suppressions().length > avant + 1);
  assert.deepEqual(suppressions().slice(avant), ['a_faire/P9999_2026-11-27.gcode', vivant]);
  hub.fichiers = null;
});

test('suppression d\'un fichier orphelin refusée par l\'agent : pas redemandée à chaque liste', async () => {
  const nom = 'a_faire/P9990_2026-11-27.gcode';
  const demandes = () => hub.appels.filter((a) => a.action === 'file.delete' && a.params.fichier === nom).length;
  hub.refuser = 'file.delete';
  await plaques.surEtat({ machine: 'kobra-1', nom: 'fichiers', donnees: { liste: [{ nom }] } });
  await plaques.surEtat({ machine: 'kobra-1', nom: 'fichiers', donnees: { liste: [{ nom }] } });
  hub.refuser = null;
  assert.equal(demandes(), 1, 'redemandée au plus une fois par heure');
});
