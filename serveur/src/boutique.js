'use strict';
// Boutique : fichiers STL, devis, adresses et commandes côté client (/api/client), gestion côté admin
// (/api/v1/boutique), échéances, rappels et tâches planifiées. Voir web_printer_user/CONCEPTION.md.
//
// Découpe des devis : src/orca.js (OrcaSlicer sur le serveur). Pas encore branchés (étapes suivantes de la
// conception) : paiement Stripe (remboursements : « paiement_non_configure »), regroupement en lots.
// L'admin ne reçoit jamais de fichier venu du navigateur d'un client : seulement le gcode découpé par le serveur.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const express = require('express');
const rateLimit = require('express-rate-limit');
const Busboy = require('busboy');
const { asynchrone } = require('./auth');
const { analyserStl, tientSur, StlInvalide } = require('./stl');
const { ErreurPaiement } = require('./paiements');
const { creerDecoupeur } = require('./orca');

const gzip = promisify(zlib.gzip);
const JOUR = 864e5;
const STATUTS_EN_COURS = ['payee', 'validee', 'dans_un_lot', 'en_impression', 'suspendue', 'imprimee'];
const STATUTS_ENVOI = ['validee', 'dans_un_lot', 'en_impression', 'suspendue', 'imprimee'];
const PROPRETES = { fine: 0.2, rapide: 0.4 };
const DEVIS_EN_ATTENTE_MAX = 3;     // par client : la découpe est lente, un client ne doit pas bloquer la file

// ---------------------------------------------------------------- règles (exportées pour les tests)

// prix de la livraison selon le poids des pièces (+ emballage)
function prixLivraison(B, poidsPiecesG) {
  const colis = poidsPiecesG + B.emballageG;
  for (const t of B.livraison) if (colis <= t.maxG) return t.cts;
  const dernier = B.livraison[B.livraison.length - 1];
  return dernier.cts + Math.ceil((colis - dernier.maxG) / 1000) * B.livraisonParKgEnPlusCts;
}

const prixMatiere = (B, poidsG) => Math.round(poidsG * B.prixGrammeCts);

// dates des rappels avant une échéance : moitié du délai, un quart restant, J-5, J-2.
// Deux rappels à moins de 24 h d'écart n'en font qu'un (on garde le plus tardif).
function datesRappels(debut, fin) {
  const D = fin - debut;
  const brut = [
    ['moitie', debut + D / 2], ['quart', fin - D / 4], ['j5', fin - 5 * JOUR], ['j2', fin - 2 * JOUR],
  ].filter(([, t]) => t > debut && t < fin).sort((a, b) => a[1] - b[1]);
  const garde = [];
  for (let i = 0; i < brut.length; i++) {
    if (i + 1 < brut.length && brut[i + 1][1] - brut[i][1] < JOUR) continue;
    garde.push([brut[i][0], Math.round(brut[i][1])]);
  }
  return garde;
}

const euros = (cts) => `${(cts / 100).toFixed(2).replace('.', ',')} €`;

// ---------------------------------------------------------------- module

function creerBoutique({ config, db, journal, courriel, paiements, clients, exige, confirme }) {
  const B = config.boutique;
  const dossierStl = path.join(config.donnees, 'stl');
  fs.mkdirSync(dossierStl, { recursive: true });
  const decoupeur = creerDecoupeur({ config, db,
    calculerPrix: (poids) => ({ prix_matiere_cts: prixMatiere(B, poids), livraison_cts: prixLivraison(B, poids) }) });

  const q = {
    imprimante: db.prepare('SELECT * FROM imprimantes WHERE id = ?'),
    imprimantes: db.prepare('SELECT * FROM imprimantes ORDER BY plateau_x_mm * plateau_y_mm, id'),
    fichier: db.prepare('SELECT * FROM fichiers_stl WHERE id = ?'),
    commande: db.prepare('SELECT * FROM commandes WHERE id = ?'),
    admins: db.prepare("SELECT email FROM utilisateurs WHERE role = 'admin' AND actif = 1"),
    clientEmail: db.prepare('SELECT email, nom FROM clients WHERE id = ?'),
    rappel: db.prepare('INSERT OR IGNORE INTO rappels (commande_id, echeance, palier, prevu_le) VALUES (?, ?, ?, ?)'),
  };

  // aperçu d'un devis : meta (JSON) ou segments (binaire, déjà compressé)
  function envoyerTrajets(res, devisId, quoi) {
    const f = decoupeur.fichiers(devisId)[quoi];
    if (!fs.existsSync(f)) return res.status(404).json({ erreur: 'apercu_absent' });
    res.set('Cache-Control', 'private, max-age=3600');
    if (quoi === 'meta') return res.type('application/json').sendFile(f);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' });
    fs.createReadStream(f).pipe(res);
  }

  const fichierPublic = (f) => ({ id: f.id, nom: f.nom_origine, taille_octets: f.taille_octets, triangles: f.triangles,
    dims_mm: [f.dim_x_mm, f.dim_y_mm, f.dim_z_mm], volume_mm3: f.volume_mm3, cree_le: f.cree_le, expire_le: f.expire_le,
    disponible: !!f.chemin });
  const imprimantePublique = (i) => ({ id: i.id, nom: i.nom, plateau_mm: [i.plateau_x_mm, i.plateau_y_mm, i.plateau_z_mm],
    buse_mm: i.buse_mm, disponible: !!i.disponible });

  function devisComplet(d) {
    const pieces = db.prepare(`SELECT p.*, f.nom_origine, f.dim_x_mm, f.dim_y_mm, f.dim_z_mm, f.chemin
      FROM devis_pieces p JOIN fichiers_stl f ON f.id = p.fichier_id WHERE p.devis_id = ? ORDER BY p.id`).all(d.id);
    return {
      id: d.id, imprimante_id: d.imprimante_id, statut: d.statut, erreur: d.erreur,
      reglages: { remplissage_pct: d.remplissage_pct, couches_surface: d.couches_surface,
        proprete: d.proprete_mm === 0.2 ? 'fine' : 'rapide' },
      poids_g: d.poids_g, duree_s: d.duree_s, nb_couches: d.nb_couches,
      prix_matiere_cts: d.prix_matiere_cts, livraison_cts: d.livraison_cts,
      total_cts: d.prix_matiere_cts == null ? null : d.prix_matiere_cts + d.livraison_cts,
      cree_le: d.cree_le, decoupe_le: d.decoupe_le,
      pieces: pieces.map((p) => ({ id: p.id, fichier_id: p.fichier_id, nom: p.nom_origine, quantite: p.quantite,
        dims_mm: [p.dim_x_mm, p.dim_y_mm, p.dim_z_mm], pos_mm: [p.pos_x_mm, p.pos_y_mm], rotation_deg: p.rotation_deg,
        poids_g: p.poids_g, fichier_disponible: !!p.chemin })),
    };
  }

  const commandePublique = (c) => ({ id: c.id, devis_id: c.devis_id, statut: c.statut, sous_total_cts: c.sous_total_cts,
    livraison_cts: c.livraison_cts, total_cts: c.total_cts, livraison_nom: c.livraison_nom,
    livraison_adresse: JSON.parse(c.livraison_adresse), cree_le: c.cree_le, paye_le: c.paye_le,
    envoi_limite_le: c.envoi_limite_le, expedie_le: c.expedie_le, numero_suivi: c.numero_suivi, rembourse_le: c.rembourse_le });

  function planifierRappels(commandeId, echeance, debut, fin) {
    for (const [palier, t] of datesRappels(debut, fin)) q.rappel.run(commandeId, echeance, palier, t);
  }

  // passe une commande en « payée » (appelé par le webhook Stripe, étape 4) : délai de validation de 10 jours
  function marquerPayee(commandeId, paiementId, maintenant = Date.now()) {
    const limite = maintenant + B.validationJours * JOUR;
    const n = db.prepare(`UPDATE commandes SET statut = 'payee', paye_le = ?, validation_limite_le = ?, stripe_paiement_id = ?
      WHERE id = ? AND statut = 'en_attente_paiement'`).run(maintenant, limite, paiementId ?? null, commandeId).changes;
    if (!n) return false;
    planifierRappels(commandeId, 'validation', maintenant, limite);
    // les STL d'une commande payée sont gardés 2 ans à partir de leur dépôt
    db.prepare(`UPDATE fichiers_stl SET expire_le = max(expire_le, cree_le + ?) WHERE id IN (
      SELECT p.fichier_id FROM devis_pieces p JOIN commandes c ON c.devis_id = p.devis_id WHERE c.id = ?)`)
      .run(B.stlCommandeConservationJours * JOUR, commandeId);
    return true;
  }

  async function prevenirClient(commande, sujet, texte) {
    const c = q.clientEmail.get(commande.client_id);
    if (!c) return;
    try {
      await courriel.envoyer({ a: c.email, sujet, texte: `Bonjour ${c.nom},\n\n${texte}\n\nCommande n° ${commande.id}.` });
    } catch (e) {
      journal('courriel.erreur', { cible: c.email, resultat: 'erreur', detail: e.message });
    }
  }

  async function prevenirAdmins(sujet, texte) {
    for (const { email } of q.admins.all()) {
      try { await courriel.envoyer({ a: email, sujet, texte }); } catch (e) {
        journal('courriel.erreur', { cible: email, resultat: 'erreur', detail: e.message });
      }
    }
  }

  // rembourse (Stripe) puis marque la commande ; le lot qui la contenait doit être redécoupé
  async function rembourser(commande, par, motif = null, adminId = null) {
    await paiements.rembourser(commande);
    const now = Date.now();
    db.prepare(`UPDATE commandes SET statut = 'remboursee', rembourse_le = ?, rembourse_par = ?, motif_refus = coalesce(?, motif_refus),
      valide_par = coalesce(valide_par, ?) WHERE id = ?`).run(now, par, motif, adminId, commande.id);
    db.prepare(`UPDATE lots SET statut = 'a_refaire' WHERE statut IN ('propose', 'pret') AND id IN (
      SELECT lp.lot_id FROM lot_pieces lp JOIN devis_pieces p ON p.id = lp.devis_piece_id WHERE p.devis_id = ?)`).run(commande.devis_id);
    const raisons = {
      admin: 'Nous ne pouvons pas imprimer ta commande. Elle t\'a été remboursée intégralement.',
      auto_validation: 'Ta commande n\'a pas pu être prise en charge à temps. Elle t\'a été remboursée intégralement.',
      auto_envoi: 'Ta commande n\'a pas pu être imprimée dans le délai prévu. Elle t\'a été remboursée intégralement.',
    };
    await prevenirClient(commande, 'Ta commande a été remboursée',
      `${raisons[par]}\nLe remboursement de ${euros(commande.total_cts)} peut mettre 5 à 10 jours ouvrés à apparaître sur ton compte.`);
    journal('boutique.remboursement', { cible: `commande ${commande.id}`, resultat: 'ok', detail: par });
  }

  // ---------------------------------------------------------------- stockage des STL

  async function enregistrerStl(clientId, nom, octets) {
    const infos = analyserStl(octets);
    const now = Date.now();
    const sha = crypto.createHash('sha256').update(octets).digest('hex');
    const relatif = path.join('stl', String(clientId), `${now}-${crypto.randomBytes(6).toString('hex')}.stl.gz`);
    fs.mkdirSync(path.join(config.donnees, path.dirname(relatif)), { recursive: true });
    await fs.promises.writeFile(path.join(config.donnees, relatif), await gzip(octets));
    const { lastInsertRowid } = db.prepare(`INSERT INTO fichiers_stl (client_id, nom_origine, chemin, taille_octets, sha256,
      triangles, dim_x_mm, dim_y_mm, dim_z_mm, volume_mm3, cree_le, expire_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(clientId, nom, relatif, octets.length, sha, infos.triangles, ...infos.dims, infos.volume, now,
        now + B.stlConservationJours * JOUR);
    return q.fichier.get(lastInsertRowid);
  }

  function supprimerFichierDisque(f) {
    if (!f.chemin) return;
    const absolu = path.join(config.donnees, f.chemin);
    if (absolu.startsWith(path.join(config.donnees, 'stl') + path.sep)) fs.rmSync(absolu, { force: true });
  }

  // fichier effacé : la ligne reste si un devis y fait référence (historique), sans le contenu
  function effacerFichier(f) {
    supprimerFichierDisque(f);
    const utilise = db.prepare('SELECT 1 FROM devis_pieces WHERE fichier_id = ? LIMIT 1').get(f.id);
    if (utilise) db.prepare("UPDATE fichiers_stl SET chemin = '' WHERE id = ?").run(f.id);
    else db.prepare('DELETE FROM fichiers_stl WHERE id = ?').run(f.id);
  }

  function lireStl(f, res, nomTelechargement) {
    if (!f.chemin) return res.status(410).json({ erreur: 'fichier_supprime' });
    res.set({ 'Content-Type': 'model/stl', 'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(nomTelechargement)}"` });
    fs.createReadStream(path.join(config.donnees, f.chemin)).pipe(zlib.createGunzip()).on('error', () => res.destroy()).pipe(res);
  }

  // ================================================================ routes client (/api/client)

  const rc = express.Router();
  const { connecte } = clients;

  rc.get('/imprimantes', (req, res) => {
    res.json(q.imprimantes.all().filter((i) => i.disponible).map(imprimantePublique));
  });

  // tarifs et délais affichés sur le site (le prix final est toujours recalculé par le serveur)
  rc.get('/tarifs', (req, res) => {
    res.json({ prix_gramme_cts: B.prixGrammeCts, emballage_g: B.emballageG, livraison: B.livraison,
      livraison_par_kg_en_plus_cts: B.livraisonParKgEnPlusCts, objectif_envoi_jours: B.objectifEnvoiJours,
      envoi_max_jours: B.envoiJours, reglages: { remplissage_pct: [5, 100], couches_surface: [2, 10], proprete: Object.keys(PROPRETES) } });
  });

  // ------------------------------------------------ fichiers STL

  const limiteEnvoi = rateLimit({ windowMs: 3600e3, limit: 60, keyGenerator: (req) => `c${req.client?.id}`,
    standardHeaders: 'draft-7', legacyHeaders: false, message: { erreur: 'trop_de_fichiers', detail: '60 fichiers par heure maximum' } });

  rc.post('/fichiers', connecte, limiteEnvoi, (req, res) => {
    const actifs = db.prepare("SELECT count(*) n FROM fichiers_stl WHERE client_id = ? AND chemin != ''").get(req.client.id).n;
    if (actifs >= 200) return res.status(409).json({ erreur: 'trop_de_fichiers', detail: '200 fichiers gardés au maximum' });
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { files: 1, fields: 0, fileSize: B.stlMaxOctets + 1 } });
    } catch {
      return res.status(400).json({ erreur: 'multipart_attendu' });
    }
    let fin = false;
    const terminer = (statut, corps) => { if (!fin) { fin = true; res.status(statut).json(corps); } };
    let travail = null;
    bb.on('file', (champ, flux, info) => {
      const nom = String(info.filename || '').replace(/[\\/\x00-\x1f]/g, '_').slice(0, 120);
      if (champ !== 'fichier' || !/\.stl$/i.test(nom)) { flux.resume(); return terminer(400, { erreur: 'stl_attendu' }); }
      const morceaux = [];
      let trop = false;
      flux.on('data', (m) => morceaux.push(m));
      flux.on('limit', () => { trop = true; flux.resume(); });
      travail = new Promise((ok) => flux.on('end', ok)).then(async () => {
        if (trop) return terminer(413, { erreur: 'fichier_trop_gros', detail: `${Math.round(B.stlMaxOctets / 1048576)} Mo maximum` });
        try {
          const f = await enregistrerStl(req.client.id, nom, Buffer.concat(morceaux));
          journal('client.fichier', { req, cible: `${req.client.email} ${nom}`, resultat: 'ok' });
          terminer(201, fichierPublic(f));
        } catch (e) {
          if (e instanceof StlInvalide) return terminer(400, { erreur: 'stl_invalide', detail: e.message });
          console.error(e);
          terminer(500, { erreur: 'erreur_interne' });
        }
      });
    });
    bb.on('close', async () => {
      if (travail) await travail;
      terminer(400, { erreur: 'fichier_manquant' });
    });
    bb.on('error', () => terminer(400, { erreur: 'multipart_invalide' }));
    req.pipe(bb);
  });

  rc.get('/fichiers', connecte, (req, res) => {
    res.json(db.prepare("SELECT * FROM fichiers_stl WHERE client_id = ? AND chemin != '' ORDER BY id DESC").all(req.client.id).map(fichierPublic));
  });

  rc.get('/fichiers/:id', connecte, (req, res) => {
    const f = q.fichier.get(Number(req.params.id));
    if (!f || f.client_id !== req.client.id) return res.status(404).json({ erreur: 'fichier_inconnu' });
    lireStl(f, res, f.nom_origine);
  });

  // droit à l'effacement : impossible seulement pendant qu'une commande en a besoin
  rc.delete('/fichiers/:id', connecte, (req, res) => {
    const f = q.fichier.get(Number(req.params.id));
    if (!f || f.client_id !== req.client.id) return res.status(404).json({ erreur: 'fichier_inconnu' });
    const enCours = db.prepare(`SELECT 1 FROM devis_pieces p JOIN commandes c ON c.devis_id = p.devis_id
      WHERE p.fichier_id = ? AND c.statut IN (${STATUTS_EN_COURS.map(() => '?').join(',')}) LIMIT 1`).get(f.id, ...STATUTS_EN_COURS);
    if (enCours) return res.status(409).json({ erreur: 'commande_en_cours', detail: 'ce fichier sert à une commande pas encore expédiée' });
    effacerFichier(f);
    journal('client.fichier.supprimer', { req, cible: `${req.client.email} ${f.nom_origine}`, resultat: 'ok' });
    res.json({ ok: true });
  });

  // ------------------------------------------------ devis

  const entier = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const reel = (v, min, max) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max);

  rc.post('/devis', connecte, (req, res) => {
    const { imprimante_id: impId, reglages, pieces, ...reste } = req.body || {};
    if (Object.keys(reste).length) return res.status(400).json({ erreur: 'champ_inconnu' });
    const imp = typeof impId === 'string' ? q.imprimante.get(impId) : null;
    if (!imp || !imp.disponible) return res.status(400).json({ erreur: 'imprimante_indisponible' });
    const { remplissage_pct: remp, couches_surface: couches, proprete, ...autres } = reglages || {};
    if (Object.keys(autres).length || !entier(remp, 5, 100) || !entier(couches, 2, 10) || !(proprete in PROPRETES)) {
      return res.status(400).json({ erreur: 'reglages_invalides', detail: 'remplissage 5-100, couches de surface 2-10, propreté fine ou rapide' });
    }
    if (!Array.isArray(pieces) || !pieces.length || pieces.length > 50) return res.status(400).json({ erreur: 'pieces_invalides', detail: '1 à 50 pièces' });
    const enCours = db.prepare("SELECT count(*) n FROM devis WHERE client_id = ? AND statut IN ('attente', 'decoupe')").get(req.client.id).n;
    if (enCours >= DEVIS_EN_ATTENTE_MAX) {
      return res.status(429).json({ erreur: 'trop_de_devis', detail: `${DEVIS_EN_ATTENTE_MAX} devis en cours de découpe au plus : attends qu'ils soient prêts` });
    }
    const lignes = [];
    for (const p of pieces) {
      const { fichier_id: fid, quantite, pos_mm: pos, rotation_deg: rot, ...trop } = p || {};
      const f = Number.isInteger(fid) ? q.fichier.get(fid) : null;
      if (Object.keys(trop).length || !f || f.client_id !== req.client.id || !f.chemin) return res.status(400).json({ erreur: 'fichier_inconnu', detail: String(fid) });
      if (!entier(quantite, 1, 50)) return res.status(400).json({ erreur: 'quantite_invalide', detail: '1 à 50' });
      if (pos !== undefined && (!Array.isArray(pos) || pos.length !== 2 || !reel(pos[0], -1000, 1000) || !reel(pos[1], -1000, 1000))) {
        return res.status(400).json({ erreur: 'position_invalide' });
      }
      if (!reel(rot, -360, 360)) return res.status(400).json({ erreur: 'rotation_invalide' });
      if (!tientSur([f.dim_x_mm, f.dim_y_mm, f.dim_z_mm], imp)) {
        return res.status(400).json({ erreur: 'piece_trop_grande', detail: `${f.nom_origine} ne tient pas sur ${imp.nom}` });
      }
      lignes.push([f.id, quantite, pos?.[0] ?? null, pos?.[1] ?? null, rot ?? 0]);
    }
    const now = Date.now();
    db.exec('BEGIN');
    try {
      const { lastInsertRowid: id } = db.prepare(`INSERT INTO devis (client_id, imprimante_id, remplissage_pct, couches_surface,
        proprete_mm, statut, cree_le) VALUES (?, ?, ?, ?, ?, 'attente', ?)`).run(req.client.id, imp.id, remp, couches, PROPRETES[proprete], now);
      const ins = db.prepare('INSERT INTO devis_pieces (devis_id, fichier_id, quantite, pos_x_mm, pos_y_mm, rotation_deg) VALUES (?, ?, ?, ?, ?, ?)');
      for (const l of lignes) ins.run(id, ...l);
      // un fichier utilisé dans un devis est gardé au moins 30 jours après ce devis
      db.prepare(`UPDATE fichiers_stl SET expire_le = max(expire_le, ?) WHERE id IN (SELECT fichier_id FROM devis_pieces WHERE devis_id = ?)`)
        .run(now + B.stlConservationJours * JOUR, id);
      db.exec('COMMIT');
      decoupeur.reveiller();
      journal('client.devis', { req, cible: `${req.client.email} devis ${id}`, resultat: 'ok', detail: `${lignes.length} pièce(s)` });
      res.status(201).json(devisComplet(db.prepare('SELECT * FROM devis WHERE id = ?').get(id)));
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  rc.get('/devis', connecte, (req, res) => {
    res.json(db.prepare('SELECT * FROM devis WHERE client_id = ? ORDER BY id DESC LIMIT 100').all(req.client.id).map(devisComplet));
  });

  rc.get('/devis/:id', connecte, (req, res) => {
    const d = db.prepare('SELECT * FROM devis WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.client.id);
    if (!d) return res.status(404).json({ erreur: 'devis_inconnu' });
    res.json(devisComplet(d));
  });

  // découpe en erreur (panne passagère d'Orca, par ex.) : le client la relance sans tout redéposer
  rc.post('/devis/:id/relancer', connecte, (req, res) => {
    const d = db.prepare('SELECT * FROM devis WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.client.id);
    if (!d) return res.status(404).json({ erreur: 'devis_inconnu' });
    if (d.statut !== 'erreur') return res.status(409).json({ erreur: 'devis_pas_en_erreur' });
    const absent = db.prepare(`SELECT f.nom_origine FROM devis_pieces p JOIN fichiers_stl f ON f.id = p.fichier_id
      WHERE p.devis_id = ? AND f.chemin = '' LIMIT 1`).get(d.id);
    if (absent) return res.status(409).json({ erreur: 'fichier_indisponible', detail: absent.nom_origine });
    const enCours = db.prepare("SELECT count(*) n FROM devis WHERE client_id = ? AND statut IN ('attente', 'decoupe')").get(req.client.id).n;
    if (enCours >= DEVIS_EN_ATTENTE_MAX) {
      return res.status(429).json({ erreur: 'trop_de_devis', detail: `${DEVIS_EN_ATTENTE_MAX} devis en cours de découpe au plus : attends qu'ils soient prêts` });
    }
    db.prepare("UPDATE devis SET statut = 'attente', erreur = NULL WHERE id = ?").run(d.id);
    decoupeur.reveiller();
    journal('client.devis.relancer', { req, cible: `${req.client.email} devis ${d.id}`, resultat: 'ok' });
    res.json(devisComplet(db.prepare('SELECT * FROM devis WHERE id = ?').get(d.id)));
  });

  // aperçu 3D du gcode découpé par le serveur (le gcode lui-même n'est jamais envoyé au client)
  const devisDuClient = (req, res) => {
    const d = db.prepare('SELECT * FROM devis WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.client.id);
    if (!d) { res.status(404).json({ erreur: 'devis_inconnu' }); return null; }
    if (d.statut !== 'pret') { res.status(409).json({ erreur: 'devis_pas_pret' }); return null; }
    return d;
  };
  rc.get('/devis/:id/trajets', connecte, (req, res) => {
    const d = devisDuClient(req, res);
    if (d) envoyerTrajets(res, d.id, 'meta');
  });
  rc.get('/devis/:id/trajets-bin', connecte, (req, res) => {
    const d = devisDuClient(req, res);
    if (d) envoyerTrajets(res, d.id, 'bin');
  });

  // ------------------------------------------------ adresses

  const texte = (v, max, requis = true) => (v === undefined || v === null || v === '' ? !requis : typeof v === 'string' && v.trim().length > 0 && v.length <= max);

  rc.get('/adresses', connecte, (req, res) => {
    res.json(db.prepare('SELECT id, nom_complet, ligne1, ligne2, code_postal, ville, pays, telephone FROM adresses WHERE client_id = ? ORDER BY id DESC')
      .all(req.client.id));
  });

  rc.post('/adresses', connecte, (req, res) => {
    const { nom_complet: nom, ligne1, ligne2, code_postal: cp, ville, pays = 'FR', telephone, ...reste } = req.body || {};
    if (Object.keys(reste).length) return res.status(400).json({ erreur: 'champ_inconnu' });
    if (!texte(nom, 100) || !texte(ligne1, 150) || !texte(ligne2, 150, false) || !texte(ville, 80)
      || typeof cp !== 'string' || !/^[0-9A-Za-z -]{3,10}$/.test(cp) || typeof pays !== 'string' || !/^[A-Z]{2}$/.test(pays)
      || !(telephone === undefined || telephone === '' || (typeof telephone === 'string' && /^[0-9 +().-]{6,20}$/.test(telephone)))) {
      return res.status(400).json({ erreur: 'adresse_invalide' });
    }
    if (db.prepare('SELECT count(*) n FROM adresses WHERE client_id = ?').get(req.client.id).n >= 20) {
      return res.status(409).json({ erreur: 'trop_d_adresses' });
    }
    const { lastInsertRowid } = db.prepare(`INSERT INTO adresses (client_id, nom_complet, ligne1, ligne2, code_postal, ville, pays, telephone, cree_le)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.client.id, nom.trim(), ligne1.trim(), ligne2?.trim() || null, cp.trim(),
      ville.trim(), pays, telephone?.trim() || null, Date.now());
    res.status(201).json({ id: Number(lastInsertRowid) });
  });

  rc.delete('/adresses/:id', connecte, (req, res) => {
    const n = db.prepare('DELETE FROM adresses WHERE id = ? AND client_id = ?').run(Number(req.params.id), req.client.id).changes;
    res.status(n ? 200 : 404).json(n ? { ok: true } : { erreur: 'adresse_inconnue' });
  });

  // ------------------------------------------------ commandes

  rc.get('/commandes', connecte, (req, res) => {
    res.json(db.prepare('SELECT * FROM commandes WHERE client_id = ? ORDER BY id DESC LIMIT 100').all(req.client.id).map(commandePublique));
  });

  rc.get('/commandes/:id', connecte, (req, res) => {
    const c = db.prepare('SELECT * FROM commandes WHERE id = ? AND client_id = ?').get(Number(req.params.id), req.client.id);
    if (!c) return res.status(404).json({ erreur: 'commande_inconnue' });
    res.json({ ...commandePublique(c), devis: devisComplet(db.prepare('SELECT * FROM devis WHERE id = ?').get(c.devis_id)) });
  });

  // ================================================================ routes admin (/api/v1/boutique)

  const ra = express.Router();
  ra.use(exige('admin'));

  ra.get('/resume', (req, res) => {
    const compte = (sql, ...a) => db.prepare(sql).get(...a).n;
    const parStatut = Object.fromEntries(db.prepare('SELECT statut, count(*) n FROM commandes GROUP BY statut').all().map((r) => [r.statut, r.n]));
    const now = Date.now();
    res.json({
      commandes: parStatut,
      a_valider: parStatut.payee || 0,
      en_retard_objectif: compte(`SELECT count(*) n FROM commandes WHERE statut IN ('validee', 'dans_un_lot', 'suspendue') AND valide_le < ?`,
        now - B.objectifEnvoiJours * JOUR),
      lots: Object.fromEntries(db.prepare('SELECT statut, count(*) n FROM lots GROUP BY statut').all().map((r) => [r.statut, r.n])),
      devis_en_attente: compte("SELECT count(*) n FROM devis WHERE statut IN ('attente', 'decoupe')"),
      clients: compte('SELECT count(*) n FROM clients'),
      stl: db.prepare("SELECT count(*) n, coalesce(sum(taille_octets), 0) octets FROM fichiers_stl WHERE chemin != ''").get(),
      paiement_configure: paiements.configure,
      courriel: courriel.mode,
    });
  });

  ra.get('/commandes', (req, res) => {
    const statuts = String(req.query.statut || '').split(',').filter(Boolean);
    const filtre = statuts.length ? `WHERE c.statut IN (${statuts.map(() => '?').join(',')})` : '';
    res.json(db.prepare(`SELECT c.*, cl.email client_email, cl.nom client_nom,
        (SELECT coalesce(sum(quantite), 0) FROM devis_pieces WHERE devis_id = c.devis_id) nb_pieces
      FROM commandes c JOIN clients cl ON cl.id = c.client_id ${filtre}
      ORDER BY coalesce(c.paye_le, c.cree_le) ASC LIMIT 500`).all(...statuts).map((c) => ({
      ...commandePublique(c), client: { id: c.client_id, email: c.client_email, nom: c.client_nom }, nb_pieces: c.nb_pieces,
      validation_limite_le: c.validation_limite_le, valide_le: c.valide_le, suspendue_le: c.suspendue_le,
      motif_refus: c.motif_refus, rembourse_par: c.rembourse_par,
    })));
  });

  ra.get('/commandes/:id', (req, res) => {
    const c = q.commande.get(Number(req.params.id));
    if (!c) return res.status(404).json({ erreur: 'commande_inconnue' });
    const cl = db.prepare('SELECT id, email, nom FROM clients WHERE id = ?').get(c.client_id);
    res.json({ ...commandePublique(c), client: cl, validation_limite_le: c.validation_limite_le, valide_le: c.valide_le,
      motif_refus: c.motif_refus, rembourse_par: c.rembourse_par,
      devis: devisComplet(db.prepare('SELECT * FROM devis WHERE id = ?').get(c.devis_id)),
      facture: db.prepare('SELECT numero, total_cts, emise_le FROM factures WHERE commande_id = ?').get(c.id) || null,
      rappels: db.prepare('SELECT echeance, palier, prevu_le, envoye_le FROM rappels WHERE commande_id = ? ORDER BY prevu_le').all(c.id) });
  });

  ra.post('/commandes/:id/valider', (req, res) => {
    const c = q.commande.get(Number(req.params.id));
    if (!c) return res.status(404).json({ erreur: 'commande_inconnue' });
    if (c.statut !== 'payee') return res.status(409).json({ erreur: 'statut_incompatible', detail: `commande ${c.statut}` });
    const now = Date.now();
    const limite = now + B.envoiJours * JOUR;
    db.prepare("UPDATE commandes SET statut = 'validee', valide_le = ?, envoi_limite_le = ?, valide_par = ? WHERE id = ?")
      .run(now, limite, req.user.id, c.id);
    db.prepare("DELETE FROM rappels WHERE commande_id = ? AND echeance = 'validation' AND envoye_le IS NULL").run(c.id);
    planifierRappels(c.id, 'envoi', now, limite);
    journal('boutique.valider', { req, cible: `commande ${c.id}`, resultat: 'ok' });
    res.json({ ok: true, envoi_limite_le: limite });
  });

  ra.post('/commandes/:id/refuser', confirme, asynchrone(async (req, res) => {
    const c = q.commande.get(Number(req.params.id));
    if (!c) return res.status(404).json({ erreur: 'commande_inconnue' });
    if (!['payee', 'validee', 'suspendue'].includes(c.statut)) return res.status(409).json({ erreur: 'statut_incompatible', detail: `commande ${c.statut}` });
    const motif = req.body?.motif;
    if (typeof motif !== 'string' || !motif.trim() || motif.length > 500) return res.status(400).json({ erreur: 'motif_requis' });
    try {
      await rembourser(c, 'admin', motif.trim(), req.user.id);
    } catch (e) {
      if (e instanceof ErreurPaiement) return res.status(503).json({ erreur: e.code, detail: e.detail });
      throw e;
    }
    journal('boutique.refuser', { req, cible: `commande ${c.id}`, resultat: 'ok', detail: motif.slice(0, 200) });
    res.json({ ok: true });
  }));

  ra.post('/commandes/:id/expedier', asynchrone(async (req, res) => {
    const c = q.commande.get(Number(req.params.id));
    if (!c) return res.status(404).json({ erreur: 'commande_inconnue' });
    if (c.statut !== 'imprimee') return res.status(409).json({ erreur: 'statut_incompatible', detail: `commande ${c.statut}` });
    const suivi = req.body?.numero_suivi;
    if (typeof suivi !== 'string' || !/^[0-9A-Za-z -]{4,40}$/.test(suivi)) return res.status(400).json({ erreur: 'numero_suivi_invalide' });
    db.prepare("UPDATE commandes SET statut = 'expediee', expedie_le = ?, numero_suivi = ? WHERE id = ?").run(Date.now(), suivi.trim(), c.id);
    await prevenirClient(c, 'Ta commande est partie', `Ta commande a été expédiée. Numéro de suivi : ${suivi.trim()}.`);
    journal('boutique.expedier', { req, cible: `commande ${c.id}`, resultat: 'ok' });
    res.json({ ok: true });
  }));

  ra.post('/commandes/:id/livree', (req, res) => {
    const n = db.prepare("UPDATE commandes SET statut = 'livree' WHERE id = ? AND statut = 'expediee'").run(Number(req.params.id)).changes;
    res.status(n ? 200 : 409).json(n ? { ok: true } : { erreur: 'statut_incompatible' });
  });

  ra.get('/lots', (req, res) => {
    res.json(db.prepare(`SELECT l.*, (SELECT coalesce(sum(quantite), 0) FROM lot_pieces WHERE lot_id = l.id) nb_pieces,
      (SELECT group_concat(DISTINCT c.id) FROM lot_pieces lp JOIN devis_pieces p ON p.id = lp.devis_piece_id
        JOIN commandes c ON c.devis_id = p.devis_id WHERE lp.lot_id = l.id) commandes
      FROM lots l ORDER BY l.id DESC LIMIT 200`).all().map((l) => ({ ...l, commandes: l.commandes ? l.commandes.split(',').map(Number) : [] })));
  });

  ra.get('/factures', (req, res) => {
    res.json(db.prepare(`SELECT f.*, c.statut commande_statut, cl.email client_email, cl.nom client_nom
      FROM factures f JOIN commandes c ON c.id = f.commande_id JOIN clients cl ON cl.id = c.client_id
      ORDER BY f.id DESC LIMIT 500`).all());
  });

  // gcode d'une commande payée : découpé par le serveur à partir du devis (jamais un fichier venu du navigateur).
  // Les STL des clients ne sont pas accessibles depuis l'admin.
  const STATUTS_SANS_GCODE = ['en_attente_paiement', 'abandonnee'];
  const commandeAvecGcode = (req, res) => {
    const c = q.commande.get(Number(req.params.id));
    if (!c) { res.status(404).json({ erreur: 'commande_inconnue' }); return null; }
    if (STATUTS_SANS_GCODE.includes(c.statut)) { res.status(409).json({ erreur: 'commande_non_payee' }); return null; }
    const d = db.prepare('SELECT * FROM devis WHERE id = ?').get(c.devis_id);
    if (!d?.gcode_chemin || !fs.existsSync(path.join(config.donnees, d.gcode_chemin))) {
      res.status(404).json({ erreur: 'gcode_absent' });
      return null;
    }
    return { c, d };
  };

  ra.get('/commandes/:id/gcode', (req, res) => {
    const r = commandeAvecGcode(req, res);
    if (!r) return;
    journal('boutique.gcode.lire', { req, cible: `commande ${r.c.id}`, resultat: 'ok' });
    res.set({ 'Content-Type': 'text/x-gcode; charset=utf-8', 'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="commande-${r.c.id}.gcode"` });
    fs.createReadStream(path.join(config.donnees, r.d.gcode_chemin)).pipe(zlib.createGunzip()).on('error', () => res.destroy()).pipe(res);
  });
  // même format que l'aperçu des fichiers de l'imprimante (visualiseur apercu3d.js de l'admin)
  ra.get('/commandes/:id/gcode/toolpath', (req, res) => {
    const r = commandeAvecGcode(req, res);
    if (r) envoyerTrajets(res, r.d.id, 'meta');
  });
  ra.get('/commandes/:id/gcode/toolpath-bin', (req, res) => {
    const r = commandeAvecGcode(req, res);
    if (r) envoyerTrajets(res, r.d.id, 'bin');
  });

  ra.get('/clients', (req, res) => {
    res.json(db.prepare(`SELECT cl.id, cl.email, cl.nom, cl.email_verifie, cl.actif, cl.cree_le,
      (SELECT count(*) FROM commandes WHERE client_id = cl.id AND statut NOT IN ('en_attente_paiement', 'abandonnee')) commandes
      FROM clients cl ORDER BY cl.id DESC LIMIT 500`).all());
  });

  ra.get('/imprimantes', (req, res) => res.json(q.imprimantes.all().map(imprimantePublique)));

  ra.patch('/imprimantes/:id', confirme, (req, res) => {
    const i = q.imprimante.get(String(req.params.id));
    if (!i) return res.status(404).json({ erreur: 'imprimante_inconnue' });
    const { disponible, plateau_mm: p, ...reste } = req.body || {};
    if (Object.keys(reste).length) return res.status(400).json({ erreur: 'champ_inconnu' });
    if (disponible !== undefined && typeof disponible !== 'boolean') return res.status(400).json({ erreur: 'disponible_invalide' });
    if (p !== undefined && (!Array.isArray(p) || p.length !== 3 || !p.every((v) => entier(v, 50, 1000)))) {
      return res.status(400).json({ erreur: 'plateau_invalide', detail: '[x, y, z] en mm, entiers de 50 à 1000' });
    }
    db.prepare('UPDATE imprimantes SET disponible = ?, plateau_x_mm = ?, plateau_y_mm = ?, plateau_z_mm = ? WHERE id = ?')
      .run(disponible === undefined ? i.disponible : Number(disponible), p?.[0] ?? i.plateau_x_mm, p?.[1] ?? i.plateau_y_mm,
        p?.[2] ?? i.plateau_z_mm, i.id);
    journal('boutique.imprimante', { req, cible: i.id, resultat: 'ok', detail: JSON.stringify(req.body) });
    res.json(imprimantePublique(q.imprimante.get(i.id)));
  });

  // ================================================================ tâches planifiées (toutes les heures)

  let paiementSignale = false;
  async function tacheHoraire(maintenant = Date.now()) {
    const bilan = { stl_supprimes: 0, devis_supprimes: 0, abandonnees: 0, rappels: 0, remboursees: 0, alertes: 0 };
    clients.purger();

    // devis jamais commandés de plus de 30 jours (avec leur gcode), puis STL arrivés à expiration
    const vieux = db.prepare('SELECT id FROM devis WHERE cree_le < ? AND id NOT IN (SELECT devis_id FROM commandes)')
      .all(maintenant - B.stlConservationJours * JOUR);
    for (const { id } of vieux) {
      decoupeur.effacer(id);
      bilan.devis_supprimes += db.prepare('DELETE FROM devis WHERE id = ?').run(id).changes;
    }
    for (const f of db.prepare("SELECT * FROM fichiers_stl WHERE expire_le < ? AND chemin != ''").all(maintenant)) {
      effacerFichier(f);
      bilan.stl_supprimes++;
    }
    db.prepare(`DELETE FROM fichiers_stl WHERE chemin = '' AND id NOT IN (SELECT fichier_id FROM devis_pieces)`).run();

    // commandes jamais payées
    bilan.abandonnees = db.prepare("UPDATE commandes SET statut = 'abandonnee' WHERE statut = 'en_attente_paiement' AND cree_le < ?")
      .run(maintenant - JOUR).changes;

    // en impression ou imprimée au-delà de la limite : alerte (une seule fois), pas de remboursement
    for (const c of db.prepare("SELECT id FROM commandes WHERE statut IN ('en_impression', 'imprimee') AND envoi_limite_le <= ?").all(maintenant)) {
      if (q.rappel.run(c.id, 'envoi', 'depasse', maintenant).changes) bilan.alertes++;
    }

    // rappels à l'admin
    const dus = db.prepare(`SELECT r.*, c.statut, c.validation_limite_le, c.envoi_limite_le FROM rappels r
      JOIN commandes c ON c.id = r.commande_id WHERE r.envoye_le IS NULL AND r.prevu_le <= ?`).all(maintenant);
    for (const r of dus) {
      const pertinent = r.echeance === 'validation' ? r.statut === 'payee' : STATUTS_ENVOI.includes(r.statut);
      if (!pertinent) { db.prepare('DELETE FROM rappels WHERE id = ?').run(r.id); continue; }
      const limite = r.echeance === 'validation' ? r.validation_limite_le : r.envoi_limite_le;
      const jours = Math.max(0, Math.ceil((limite - maintenant) / JOUR));
      const quoi = r.echeance === 'validation' ? 'à valider ou refuser' : 'à imprimer et expédier';
      await prevenirAdmins(r.palier === 'depasse' ? `Commande ${r.commande_id} : limite d'envoi dépassée`
        : `Rappel : commande ${r.commande_id} ${quoi} (${jours} j restants)`,
      r.palier === 'depasse'
        ? `La commande ${r.commande_id} est ${r.statut} mais sa limite d'envoi est dépassée. Elle n'a pas été remboursée `
          + 'automatiquement (pièce en cours ou déjà imprimée) : expédie-la ou décide toi-même.'
        : `La commande ${r.commande_id} est ${quoi}. Il reste ${jours} jour(s) avant son remboursement automatique.`);
      db.prepare('UPDATE rappels SET envoye_le = ? WHERE id = ?').run(maintenant, r.id);
      bilan.rappels++;
    }

    // remboursements automatiques (10 jours sans validation, limite d'envoi dépassée sans impression)
    const aRembourser = [
      ...db.prepare("SELECT *, 'auto_validation' par FROM commandes WHERE statut = 'payee' AND validation_limite_le <= ?").all(maintenant),
      ...db.prepare(`SELECT *, 'auto_envoi' par FROM commandes WHERE statut IN ('validee', 'dans_un_lot', 'suspendue')
        AND envoi_limite_le <= ?`).all(maintenant),
    ];
    for (const c of aRembourser) {
      try {
        await rembourser(c, c.par);
        bilan.remboursees++;
      } catch (e) {
        if (!(e instanceof ErreurPaiement)) throw e;
        if (!paiementSignale) journal('boutique.remboursement', { cible: `commande ${c.id}`, resultat: 'erreur', detail: e.code });
        paiementSignale = true;
      }
    }

    return bilan;
  }

  return { routesClient: rc, routesAdmin: ra, tacheHoraire, marquerPayee, planifierRappels, enregistrerStl, decoupeur };
}

module.exports = { creerBoutique, prixLivraison, prixMatiere, datesRappels };
