'use strict';
// Plaques à imprimer (table lots) : une plaque = un plateau imprimé d'un coup.
// Étape 1 : une plaque par devis d'une commande validée par l'admin. Étape 2 (plus tard) : plusieurs commandes
// fusionnées sur une plaque ; tout est déjà pièce par pièce (lot_pieces), la fiche de tri sait le montrer.
//
// Plaque :   a_envoyer -> a_faire (gcode dans « a_faire/ » sur l'imprimante) -> en_impression -> imprimee
//            -> validee (pop-up de l'admin : fichier rangé dans « imprimees/ », nom + date + client)
//            ratée : retour à a_faire (relance proposée si la machine est libre)
// Commande : validee -> dans_un_lot (« en attente d'impression ») -> en_impression -> imprimee -> expediee
//
// L'impression est suivie d'après l'état que l'agent envoie toutes les 2 s (nom du fichier + état de Klipper) :
// une plaque lancée depuis l'admin OU depuis l'écran de l'imprimante est reconnue à son nom de fichier.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const express = require('express');
const { asynchrone } = require('./auth');

const A_FAIRE = 'a_faire';
const IMPRIMEES = 'imprimees';
const ACTIF = new Set(['printing', 'paused']);
const STATUTS_SUIVIS = ['validee', 'dans_un_lot', 'en_impression'];      // commandes que les plaques font avancer

const numero = (id) => `P${String(id).padStart(4, '0')}`;
// date et heure de Paris : « 2026-11-22 » et « 15h40 »
function dateParis(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { jour: `${p.year}-${p.month}-${p.day}`, heure: `${p.hour}h${p.minute}` };
}
// nom de client utilisable dans un nom de fichier : « Clément Avesque » -> « Clement-Avesque »
const nomFichier = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '').slice(0, 40) || 'client';
const ref = (uuid) => (uuid ? uuid.slice(0, 8).toUpperCase() : null);

function creerPlaques({ config, db, hub, journal, quandImprimee = async () => {} }) {
  const dossierTmp = path.join(config.donnees, 'uploads');
  fs.mkdirSync(dossierTmp, { recursive: true });

  const q = {
    plaque: db.prepare('SELECT * FROM lots WHERE id = ?'),
    // commandes d'une plaque (et inversement), à travers les pièces des devis
    commandesDe: db.prepare(`SELECT DISTINCT cd.commande_id id FROM lot_pieces lp JOIN devis_pieces p ON p.id = lp.devis_piece_id
      JOIN commande_devis cd ON cd.devis_id = p.devis_id WHERE lp.lot_id = ?`),
    plaquesDe: db.prepare(`SELECT DISTINCT l.* FROM lots l JOIN lot_pieces lp ON lp.lot_id = l.id
      JOIN devis_pieces p ON p.id = lp.devis_piece_id JOIN commande_devis cd ON cd.devis_id = p.devis_id
      WHERE cd.commande_id = ? AND l.statut != 'annulee'`),
    plaqueDuDevis: db.prepare(`SELECT DISTINCT l.id FROM lots l JOIN lot_pieces lp ON lp.lot_id = l.id
      JOIN devis_pieces p ON p.id = lp.devis_piece_id WHERE p.devis_id = ? AND l.statut != 'annulee'`),
    statut: db.prepare('UPDATE lots SET statut = ?, erreur = NULL WHERE id = ?'),
  };

  const occupee = (machine) => {
    const e = hub.machine(machine)?.etat?.print;
    return !!e && (['PRINTING', 'BREAK'].includes(e.state) || ACTIF.has(e.etat_klipper));
  };

  // ------------------------------------------------------------ fiche de tri : qui a quoi sur la plaque

  function contenu(lotId) {
    const lignes = db.prepare(`SELECT c.id commande_id, c.uuid commande_uuid, cl.nom client_nom, cl.email client_email, d.uuid devis_uuid,
        f.nom_origine nom, lp.quantite, p.echelle, f.dim_x_mm, f.dim_y_mm, f.dim_z_mm
      FROM lot_pieces lp JOIN devis_pieces p ON p.id = lp.devis_piece_id JOIN devis d ON d.id = p.devis_id
      JOIN fichiers_stl f ON f.id = p.fichier_id JOIN commande_devis cd ON cd.devis_id = d.id
      JOIN commandes c ON c.id = cd.commande_id JOIN clients cl ON cl.id = c.client_id
      WHERE lp.lot_id = ? ORDER BY c.id, lp.id`).all(lotId);
    const parCommande = new Map();
    for (const l of lignes) {
      if (!parCommande.has(l.commande_id)) {
        parCommande.set(l.commande_id, { commande_id: l.commande_id, ref: ref(l.commande_uuid), client_nom: l.client_nom,
          client_email: l.client_email, devis_ref: ref(l.devis_uuid), pieces: [] });
      }
      parCommande.get(l.commande_id).pieces.push({ nom: l.nom, quantite: l.quantite, echelle: l.echelle,
        dims_mm: [l.dim_x_mm, l.dim_y_mm, l.dim_z_mm].map((v) => Math.round(v * l.echelle * 10) / 10) });
    }
    return [...parCommande.values()];
  }

  const vue = (l) => ({ id: l.id, numero: numero(l.id), statut: l.statut, imprimante_id: l.imprimante_id, fichier: l.fichier_machine,
    erreur: l.erreur, tentatives: l.tentatives, duree_s: l.duree_s, cree_le: l.cree_le, envoye_le: l.envoye_le, lance_le: l.lance_le,
    fini_le: l.fini_le, valide_le: l.valide_le, machine_occupee: occupee(l.imprimante_id), contenu: contenu(l.id) });

  // ------------------------------------------------------------ avancement des commandes

  async function majCommande(commandeId) {
    const c = db.prepare('SELECT * FROM commandes WHERE id = ?').get(commandeId);
    if (!c || !STATUTS_SUIVIS.includes(c.statut)) return;
    const plaques = q.plaquesDe.all(commandeId);
    if (!plaques.length) return;
    const tous = (...s) => plaques.every((p) => s.includes(p.statut));
    const un = (...s) => plaques.some((p) => s.includes(p.statut));
    const statut = tous('validee') ? 'imprimee'
      : un('en_impression', 'imprimee', 'validee') ? 'en_impression'
        : tous('a_faire') ? 'dans_un_lot' : 'validee';
    if (statut === c.statut) return;
    db.prepare('UPDATE commandes SET statut = ? WHERE id = ?').run(statut, commandeId);
    journal('boutique.commande.statut', { cible: `commande ${commandeId}`, resultat: 'ok', detail: `${c.statut} -> ${statut}` });
    if (statut === 'imprimee') await quandImprimee(c).catch((e) => console.error(`[plaques] e-mail commande ${commandeId} : ${e.message}`));
  }
  const majCommandesDe = async (lotId) => { for (const { id } of q.commandesDe.all(lotId)) await majCommande(id); };

  // ------------------------------------------------------------ création à la validation d'une commande

  // une plaque par devis de la commande (pas de doublon si la commande est revalidée)
  function creerPourCommande(commandeId) {
    const devis = db.prepare(`SELECT d.* FROM commande_devis cd JOIN devis d ON d.id = cd.devis_id
      WHERE cd.commande_id = ? ORDER BY d.id`).all(commandeId);
    const creees = [];
    db.exec('BEGIN');
    try {
      for (const d of devis) {
        if (q.plaqueDuDevis.get(d.id) || !d.gcode_chemin) continue;
        const id = Number(db.prepare(`INSERT INTO lots (imprimante_id, proprete_mm, statut, gcode_chemin, duree_s, cree_le)
          VALUES (?, ?, 'a_envoyer', ?, ?, ?)`).run(d.imprimante_id, d.proprete_mm, d.gcode_chemin, d.duree_s, Date.now()).lastInsertRowid);
        db.prepare(`INSERT INTO lot_pieces (lot_id, devis_piece_id, quantite, remplissage_pct, couches_surface, pos_x_mm, pos_y_mm)
          SELECT ?, p.id, p.quantite, ?, ?, p.pos_x_mm, p.pos_y_mm FROM devis_pieces p WHERE p.devis_id = ?`)
          .run(id, d.remplissage_pct, d.couches_surface, d.id);
        creees.push(id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    for (const id of creees) journal('boutique.plaque', { cible: `${numero(id)} commande ${commandeId}`, resultat: 'ok', detail: 'créée' });
    setImmediate(() => travail());
    return creees;
  }

  // commande remboursée : ses plaques pas encore imprimées sont annulées
  function annulerPourCommande(commandeId) {
    for (const l of q.plaquesDe.all(commandeId)) {
      if (['a_envoyer', 'a_faire'].includes(l.statut)) q.statut.run('annulee', l.id);
    }
  }

  // ------------------------------------------------------------ envoi dans « a_faire/ » et rangement

  async function envoyer(l) {
    // nom libre sur l'imprimante : un fichier du même nom (numéros repartis de 1 après un nettoyage de la base)
    // serait écrasé, et l'admin verrait l'ancien aperçu -> P0001_2026-11-22-2.gcode, -3...
    const base = `${A_FAIRE}/${numero(l.id)}_${dateParis(Date.now()).jour}`;
    const pris = new Set((hub.machine(l.imprimante_id)?.fichiers || []).map((f) => f.nom));
    let nom = `${base}.gcode`;
    for (let k = 2; pris.has(nom) && k < 100; k++) nom = `${base}-${k}.gcode`;
    const transfert = crypto.randomBytes(12).toString('base64url');
    const tmp = path.join(dossierTmp, `${transfert}.gcode`);
    try {
      // gcode stocké compressé sur le serveur : décompressé pour l'envoi (taille et empreinte vérifiées par l'agent)
      const hash = crypto.createHash('sha256');
      let taille = 0;
      await pipeline(fs.createReadStream(path.join(config.donnees, l.gcode_chemin)), zlib.createGunzip(),
        async function* (source) { for await (const m of source) { hash.update(m); taille += m.length; yield m; } },
        fs.createWriteStream(tmp));
      const r = await hub.commande(l.imprimante_id, 'file.upload', { fichier: nom, taille, sha256: hash.digest('hex'), transfert },
        { user: 'serveur (plaques)', envoi: (c) => hub.envoyerFichier(c, tmp, transfert) });
      if (!r.ok) throw new Error(r.detail || r.erreur || 'refusé par l\'agent');
      db.prepare("UPDATE lots SET statut = 'a_faire', fichier_machine = ?, envoye_le = ?, erreur = NULL WHERE id = ? AND statut = 'a_envoyer'")
        .run(nom, Date.now(), l.id);
      journal('boutique.plaque', { cible: numero(l.id), resultat: 'ok', detail: `envoyée : ${nom}` });
      hub.rafraichirFichiers(l.imprimante_id).catch(() => {});
      await majCommandesDe(l.id);
    } catch (e) {
      db.prepare('UPDATE lots SET erreur = ? WHERE id = ?').run(`envoi : ${e.detail || e.message}`.slice(0, 300), l.id);
      console.error(`[plaques] ${numero(l.id)} : envoi impossible (${e.detail || e.message})`);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  async function ranger(l) {
    const r = await hub.commande(l.imprimante_id, 'file.move', { source: l.fichier_machine, destination: l.rangement },
      { user: 'serveur (plaques)' });
    if (!r.ok) throw new Error(r.detail || r.erreur || 'refusé par l\'agent');
    db.prepare('UPDATE lots SET fichier_machine = rangement, rangement = NULL, erreur = NULL WHERE id = ?').run(l.id);
    hub.rafraichirFichiers(l.imprimante_id).catch(() => {});
  }

  // envois et rangements en attente (agent absent, envoi raté...) : au démarrage, à la connexion de l'agent,
  // à chaque validation et toutes les minutes. Un seul passage à la fois ; une demande pendant un passage
  // en relance un juste après (rien n'est oublié), et la promesse rendue attend la fin du tout.
  async function passe() {
    for (const l of db.prepare("SELECT * FROM lots WHERE statut = 'a_envoyer' ORDER BY id").all()) {
      if (!hub.lien) break;
      if (hub.machine(l.imprimante_id)?.enLigne === false) continue;
      await envoyer(l);
    }
    for (const l of db.prepare("SELECT * FROM lots WHERE rangement IS NOT NULL ORDER BY id").all()) {
      if (!hub.lien) break;
      await ranger(l).catch((e) => db.prepare('UPDATE lots SET erreur = ? WHERE id = ?').run(`rangement : ${e.detail || e.message}`.slice(0, 300), l.id));
    }
  }
  let enCours = null;
  let encore = false;
  let arrete = false;
  function travail() {
    if (arrete || !hub.lien) return Promise.resolve();
    if (enCours) { encore = true; return enCours; }
    enCours = (async () => {
      try {
        do { encore = false; await passe(); } while (encore && hub.lien && !arrete);
      } finally {
        enCours = null;
      }
    })();
    return enCours;
  }

  // ------------------------------------------------------------ suivi de l'impression (état de l'agent)

  // le fichier de la plaque est-il dans la liste de l'imprimante ? (null : liste pas encore reçue)
  function surImprimante(l) {
    const liste = hub.machine(l.imprimante_id)?.fichiers;
    return Array.isArray(liste) ? liste.some((f) => f.nom === l.fichier_machine) : null;
  }
  // plaque « à faire » dont le fichier n'est plus sur l'imprimante (envoyée à un ancien agent, effacée à la
  // main, index de l'agent refait...) : elle repart en envoi
  function aRenvoyer(l, raison) {
    db.prepare("UPDATE lots SET statut = 'a_envoyer', erreur = ? WHERE id = ? AND statut = 'a_faire'").run(raison, l.id);
    journal('boutique.plaque', { cible: numero(l.id), resultat: 'ok', detail: raison });
  }

  // liste des fichiers reçue : les plaques à faire absentes sont renvoyées (pas celles envoyées il y a moins
  // d'une minute : une liste en retard sur l'envoi ne doit pas les faire repartir)
  async function surFichiers(machine, liste) {
    if (!Array.isArray(liste)) return;
    const noms = new Set(liste.map((f) => f?.nom));
    const manquantes = db.prepare("SELECT * FROM lots WHERE imprimante_id = ? AND statut = 'a_faire' AND coalesce(envoye_le, 0) < ?")
      .all(machine, Date.now() - 60e3).filter((l) => !noms.has(l.fichier_machine));
    for (const l of manquantes) {
      aRenvoyer(l, `fichier absent de l'imprimante (${l.fichier_machine}) : renvoyé`);
      await majCommandesDe(l.id);
    }
    if (manquantes.length) setImmediate(() => travail().catch(() => {}));
  }

  async function surEtat({ machine, nom, donnees }) {
    if (nom === 'fichiers') return surFichiers(machine, donnees?.liste);
    if (nom !== 'etat' || !donnees?.print) return;
    const p = donnees.print;
    const actif = ['PRINTING', 'BREAK'].includes(p.state) || ACTIF.has(p.etat_klipper);
    // plaque lancée (depuis l'admin ou l'écran de l'imprimante) : reconnue à son nom de fichier
    if (actif && p.filename) {
      const l = db.prepare("SELECT * FROM lots WHERE imprimante_id = ? AND fichier_machine = ? AND statut = 'a_faire'").get(machine, p.filename);
      if (l) {
        db.prepare("UPDATE lots SET statut = 'en_impression', lance_le = ?, tentatives = tentatives + 1, erreur = NULL WHERE id = ?")
          .run(Date.now(), l.id);
        journal('boutique.plaque', { cible: numero(l.id), resultat: 'ok', detail: 'impression lancée' });
        await majCommandesDe(l.id);
      }
    }
    // plaque en impression qui ne l'est plus : finie (à valider par l'admin), ou annulée / en erreur (à refaire)
    for (const l of db.prepare("SELECT * FROM lots WHERE imprimante_id = ? AND statut = 'en_impression'").all(machine)) {
      if (actif && p.filename === l.fichier_machine) continue;
      const rate = ['cancelled', 'error'].includes(p.etat_klipper) && p.filename === l.fichier_machine;
      db.prepare('UPDATE lots SET statut = ?, fini_le = ? WHERE id = ?').run(rate ? 'a_faire' : 'imprimee', rate ? null : Date.now(), l.id);
      journal('boutique.plaque', { cible: numero(l.id), resultat: 'ok', detail: rate ? `impression ${p.etat_klipper} : à refaire` : 'imprimée, à valider' });
      await majCommandesDe(l.id);
    }
  }

  const ecouteur = (ev) => { surEtat(ev).catch((e) => console.error(`[plaques] suivi : ${e.message}`)); };
  const auConnecte = (s) => { if (s?.connecte) setTimeout(() => travail().catch(() => {}), 2000); };
  hub.on('evenement', ecouteur);
  hub.on('agent', auConnecte);
  const minuteur = setInterval(() => travail().catch(() => {}), 60e3);
  minuteur.unref?.();
  setImmediate(() => travail().catch(() => {}));

  // ------------------------------------------------------------ actions de l'admin

  class ErreurPlaque extends Error {
    constructor(statut, code, detail) { super(detail || code); this.statut = statut; this.code = code; this.detail = detail; }
  }
  const exiger = (id, ...statuts) => {
    const l = q.plaque.get(Number(id));
    if (!l) throw new ErreurPlaque(404, 'plaque_inconnue');
    if (statuts.length && !statuts.includes(l.statut)) throw new ErreurPlaque(409, 'statut_incompatible', `plaque ${l.statut}`);
    return l;
  };

  // impression bonne : la plaque est rangée dans « imprimees/ » (numéro, date, heure, client), commandes à jour
  async function valider(id, adminId) {
    const l = exiger(id, 'imprimee');
    const c = contenu(l.id);
    const qui = c.length === 1 ? nomFichier(c[0].client_nom) : `${c.length}-clients`;
    const { jour, heure } = dateParis(Date.now());
    const destination = `${IMPRIMEES}/${numero(l.id)}_${jour}_${heure}_${qui}.gcode`;
    db.prepare("UPDATE lots SET statut = 'validee', valide_le = ?, valide_par = ?, rangement = ?, erreur = NULL WHERE id = ?")
      .run(Date.now(), adminId ?? null, l.fichier_machine ? destination : null, l.id);
    journal('boutique.plaque', { cible: numero(l.id), resultat: 'ok', detail: 'validée' });
    await majCommandesDe(l.id);
    // rangement tout de suite si l'agent est là, sinon au prochain passage
    let range = false;
    if (l.fichier_machine && hub.lien) {
      try { await ranger(q.plaque.get(l.id)); range = true; } catch (e) {
        db.prepare('UPDATE lots SET erreur = ? WHERE id = ?').run(`rangement : ${e.detail || e.message}`.slice(0, 300), l.id);
      }
    }
    return { ...vue(q.plaque.get(l.id)), range };
  }

  // impression ratée : retour dans « a_faire » ; la relance est possible si la machine est libre
  async function rater(id) {
    const l = exiger(id, 'imprimee');
    db.prepare("UPDATE lots SET statut = 'a_faire', fini_le = NULL, erreur = NULL WHERE id = ?").run(l.id);
    journal('boutique.plaque', { cible: numero(l.id), resultat: 'ok', detail: 'ratée : à refaire' });
    await majCommandesDe(l.id);
    return { ...vue(q.plaque.get(l.id)), relancable: !occupee(l.imprimante_id) };
  }

  // lancement de l'impression d'une plaque (elle passera « en impression » dès que l'agent le confirme)
  async function lancer(id, user) {
    let l = exiger(id, 'a_faire');
    if (occupee(l.imprimante_id)) throw new ErreurPlaque(409, 'machine_occupee', 'l\'imprimante est déjà en train d\'imprimer');
    // fichier absent de l'imprimante : renvoyé d'abord, puis lancé
    await hub.rafraichirFichiers(l.imprimante_id).catch(() => {});
    l = q.plaque.get(l.id);
    if (!['a_faire', 'a_envoyer'].includes(l.statut)) throw new ErreurPlaque(409, 'statut_incompatible', `plaque ${l.statut}`);
    if (l.statut === 'a_envoyer' || surImprimante(l) === false) {
      aRenvoyer(l, `fichier absent de l'imprimante (${l.fichier_machine}) : renvoyé avant le lancement`);
      await travail();
      l = q.plaque.get(l.id);
      if (l.statut !== 'a_faire') throw new ErreurPlaque(502, 'envoi_impossible', l.erreur || 'renvoi du fichier impossible');
    }
    const r = await hub.commande(l.imprimante_id, 'print.start', { fichier: l.fichier_machine }, { user });
    if (!r.ok) throw new ErreurPlaque(502, r.erreur || 'lancement_impossible', r.detail);
    journal('boutique.plaque', { cible: numero(l.id), resultat: 'ok', detail: 'lancée depuis l\'admin' });
    return vue(q.plaque.get(l.id));
  }

  // ------------------------------------------------------------ routes admin (/api/v1/boutique/plaques)

  const routes = express.Router();
  const repondre = (fn) => asynchrone(async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      if (e instanceof ErreurPlaque) return res.status(e.statut).json({ erreur: e.code, detail: e.detail });
      if (e?.code && e?.statut) return res.status(e.statut).json({ erreur: e.code, detail: e.detail });
      throw e;
    }
  });
  routes.get('/', repondre(() => db.prepare(`SELECT * FROM lots WHERE statut NOT IN ('validee', 'annulee')
    OR coalesce(valide_le, cree_le) > ? ORDER BY id DESC LIMIT 200`).all(Date.now() - 30 * 864e5).map(vue)));
  // plaques imprimées en attente de la validation de l'admin (pop-up sur toutes les pages)
  routes.get('/a-valider', repondre(() => db.prepare("SELECT * FROM lots WHERE statut = 'imprimee' ORDER BY fini_le").all().map(vue)));
  routes.get('/:id', repondre((req) => vue(exiger(req.params.id))));
  routes.post('/:id/valider', repondre((req) => valider(req.params.id, req.user.id)));
  routes.post('/:id/ratee', repondre((req) => rater(req.params.id)));
  routes.post('/:id/lancer', repondre((req) => lancer(req.params.id, req.user.email)));
  routes.post('/:id/renvoyer', repondre(async (req) => {
    exiger(req.params.id, 'a_envoyer');
    await travail();
    return vue(q.plaque.get(Number(req.params.id)));
  }));

  return {
    routes, creerPourCommande, annulerPourCommande, contenu, numero, valider, rater, lancer, travail, surEtat,
    // plaques d'une commande (fiche admin, bon de colis)
    deLaCommande: (commandeId) => q.plaquesDe.all(commandeId).map((l) => ({ id: l.id, numero: numero(l.id), statut: l.statut,
      fichier: l.fichier_machine, valide_le: l.valide_le })),
    // arrêt du serveur : plus de nouveau passage, celui en cours se termine avant la fermeture de la base
    async arreter() {
      arrete = true;
      clearInterval(minuteur);
      hub.off('evenement', ecouteur);
      hub.off('agent', auConnecte);
      await enCours?.catch(() => {});
    },
  };
}

module.exports = { creerPlaques, numero, nomFichier, dateParis };
