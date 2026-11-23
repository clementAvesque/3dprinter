'use strict';
// Boutique : fichiers STL, devis, adresses et commandes côté client (/api/client), gestion côté admin
// (/api/v1/boutique), échéances, rappels et tâches planifiées. Voir web_printer_user/CONCEPTION.md.
//
// Découpe des devis : src/orca.js (OrcaSlicer sur le serveur). Paiement : src/paiements.js (Stripe Checkout,
// webhook signé, remboursements). Pas encore branché (étape suivante de la conception) : regroupement en lots.
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
const S = require('./securite');
const { analyserStl, tientSur, StlInvalide } = require('./stl');
const { ErreurPaiement } = require('./paiements');
const { creerDecoupeur } = require('./orca');
const { creerPlaques } = require('./plaques');

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

function creerBoutique({ config, db, hub, journal, courriel, paiements, clients, exige, confirme }) {
  const B = config.boutique;
  const dossierStl = path.join(config.donnees, 'stl');
  fs.mkdirSync(dossierStl, { recursive: true });
  const decoupeur = creerDecoupeur({ config, db,
    calculerPrix: (poids) => ({ prix_matiere_cts: prixMatiere(B, poids), livraison_cts: prixLivraison(B, poids) }) });
  // plaques à imprimer : créées à la validation d'une commande, envoyées dans « a_faire/ » sur l'imprimante
  const plaques = creerPlaques({ config, db, hub, journal,
    quandImprimee: (c) => prevenirClient(c, 'Ta commande est imprimée',
      'Bonne nouvelle : toutes tes pièces sont imprimées et vérifiées. Nous préparons le colis, tu recevras le numéro de suivi à l\'envoi.') });

  const q = {
    imprimante: db.prepare('SELECT * FROM imprimantes WHERE id = ?'),
    imprimantes: db.prepare('SELECT * FROM imprimantes ORDER BY plateau_x_mm * plateau_y_mm, id'),
    fichier: db.prepare('SELECT * FROM fichiers_stl WHERE id = ?'),
    commande: db.prepare('SELECT * FROM commandes WHERE id = ?'),
    admins: db.prepare("SELECT email FROM utilisateurs WHERE role = 'admin' AND actif = 1"),
    clientEmail: db.prepare('SELECT email, nom FROM clients WHERE id = ?'),
    rappel: db.prepare('INSERT OR IGNORE INTO rappels (commande_id, echeance, palier, prevu_le) VALUES (?, ?, ?, ?)'),
    // commandes groupées : devis d'une commande, commande d'un devis
    devisDe: db.prepare('SELECT devis_id FROM commande_devis WHERE commande_id = ? ORDER BY devis_id'),
    commandeDuDevis: db.prepare(`SELECT c.* FROM commande_devis cd JOIN commandes c ON c.id = cd.commande_id WHERE cd.devis_id = ?`),
    // côté client, tout passe par l'identifiant public (UUID) et le propriétaire
    devisDuClient: db.prepare('SELECT * FROM devis WHERE uuid = ? AND client_id = ?'),
    fichierDuClient: db.prepare('SELECT * FROM fichiers_stl WHERE uuid = ? AND client_id = ?'),
    commandeDuClient: db.prepare('SELECT * FROM commandes WHERE uuid = ? AND client_id = ?'),
    adresseDuClient: db.prepare('SELECT * FROM adresses WHERE uuid = ? AND client_id = ?'),
  };
  const idsDevis = (commandeId) => q.devisDe.all(commandeId).map((r) => r.devis_id);
  // référence courte affichée au client (« Devis 3F9A2C1B ») : début de l'UUID, ne dit rien du nombre de devis
  const ref = (uuid) => (uuid ? uuid.slice(0, 8).toUpperCase() : null);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const uuidValide = (v) => typeof v === 'string' && UUID_RE.test(v);

  // aperçu d'un devis : meta (JSON) ou segments (binaire, déjà compressé)
  function envoyerTrajets(res, devisId, quoi) {
    const f = decoupeur.fichiers(devisId)[quoi];
    if (!fs.existsSync(f)) return res.status(404).json({ erreur: 'apercu_absent' });
    res.set('Cache-Control', 'private, max-age=3600');
    if (quoi === 'meta') return res.type('application/json').sendFile(f);
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip' });
    fs.createReadStream(f).pipe(res);
  }

  const fichierPublic = (f) => ({ id: f.uuid, nom: f.nom_origine, taille_octets: f.taille_octets, triangles: f.triangles,
    dims_mm: [f.dim_x_mm, f.dim_y_mm, f.dim_z_mm], volume_mm3: f.volume_mm3, cree_le: f.cree_le, expire_le: f.expire_le,
    disponible: !!f.chemin });
  const imprimantePublique = (i) => ({ id: i.id, nom: i.nom, plateau_mm: [i.plateau_x_mm, i.plateau_y_mm, i.plateau_z_mm],
    buse_mm: i.buse_mm, disponible: !!i.disponible });

  // galerie : projet d'origine d'un devis créé depuis la galerie, publication d'un devis par son auteur
  const galerieDe = (publicationId) => {
    const p = db.prepare('SELECT p.uuid, p.titre, c.pseudo FROM publications p JOIN clients c ON c.id = p.client_id WHERE p.id = ?').get(publicationId);
    return p ? { id: p.uuid, titre: p.titre, auteur: p.pseudo || 'ancien membre' } : null;
  };
  const publicationDuDevis = (devisId) => {
    const p = db.prepare('SELECT uuid, titre, retiree_le, choisie FROM publications WHERE devis_id = ?').get(devisId);
    return p && !p.retiree_le ? { id: p.uuid, titre: p.titre, choisie: p.choisie } : null;
  };

  // devis vu par son client (identifiants publics) ou par l'admin (numéros internes en plus)
  function devisComplet(d, { admin = false } = {}) {
    const pieces = db.prepare(`SELECT p.*, f.nom_origine, f.dim_x_mm, f.dim_y_mm, f.dim_z_mm, f.chemin, f.uuid fichier_uuid, f.client_id fichier_client
      FROM devis_pieces p JOIN fichiers_stl f ON f.id = p.fichier_id WHERE p.devis_id = ? ORDER BY p.id`).all(d.id);
    const c = q.commandeDuDevis.get(d.id);
    return {
      id: admin ? d.id : d.uuid, uuid: d.uuid, ref: ref(d.uuid), imprimante_id: d.imprimante_id, statut: d.statut, erreur: d.erreur,
      reglages: { remplissage_pct: d.remplissage_pct, couches_surface: d.couches_surface,
        proprete: d.proprete_mm === 0.2 ? 'fine' : 'rapide' },
      poids_g: d.poids_g, duree_s: d.duree_s, nb_couches: d.nb_couches,
      prix_matiere_cts: d.prix_matiere_cts, livraison_cts: d.livraison_cts,
      total_cts: d.prix_matiere_cts == null ? null : d.prix_matiere_cts + d.livraison_cts,
      cree_le: d.cree_le, decoupe_le: d.decoupe_le,
      commande: c ? { id: admin ? c.id : c.uuid, ref: ref(c.uuid), statut: c.statut } : null,
      progression: decoupeur.progression(d),
      // galerie : projet d'un autre client (son fichier n'est jamais exposé) ; projet publié par son auteur
      galerie: d.publication_id ? galerieDe(d.publication_id) : null,
      publication: admin ? null : publicationDuDevis(d.id),
      pieces: pieces.map((p, i) => ({ id: admin ? p.id : i + 1,
        fichier_id: admin ? p.fichier_id : (p.fichier_client === d.client_id ? p.fichier_uuid : null),
        nom: p.nom_origine, quantite: p.quantite,
        dims_mm: [p.dim_x_mm, p.dim_y_mm, p.dim_z_mm].map((v) => v * p.echelle), echelle: p.echelle,
        pos_mm: [p.pos_x_mm, p.pos_y_mm], rotation_deg: p.rotation_deg,
        poids_g: p.poids_g, fichier_disponible: !!p.chemin })),
    };
  }

  // commande vue par son client (UUID) ou par l'admin (numéros internes en plus)
  const uuidDevis = (id) => db.prepare('SELECT uuid FROM devis WHERE id = ?').get(id)?.uuid;
  const commandePublique = (c, { admin = false } = {}) => ({ id: admin ? c.id : c.uuid, uuid: c.uuid, ref: ref(c.uuid),
    devis_id: admin ? c.devis_id : uuidDevis(c.devis_id),
    devis_ids: admin ? idsDevis(c.id) : idsDevis(c.id).map(uuidDevis), statut: c.statut, sous_total_cts: c.sous_total_cts,
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
      SELECT p.fichier_id FROM devis_pieces p JOIN commande_devis cd ON cd.devis_id = p.devis_id WHERE cd.commande_id = ?)`)
      .run(B.stlCommandeConservationJours * JOUR, commandeId);
    return true;
  }

  // facture à numérotation continue par année (obligatoire en France) : 2026-000001, 2026-000002...
  function emettreFacture(commande, maintenant = Date.now()) {
    const an = new Date(maintenant).getFullYear();
    const dernier = db.prepare('SELECT numero FROM factures WHERE numero LIKE ? ORDER BY numero DESC LIMIT 1').get(`${an}-%`);
    const numero = `${an}-${String((dernier ? Number(dernier.numero.slice(5)) : 0) + 1).padStart(6, '0')}`;
    db.prepare('INSERT OR IGNORE INTO factures (commande_id, numero, total_cts, emise_le) VALUES (?, ?, ?, ?)')
      .run(commande.id, numero, commande.total_cts, maintenant);
    return db.prepare('SELECT * FROM factures WHERE commande_id = ?').get(commande.id);
  }

  async function prevenirClient(commande, sujet, texte) {
    const c = q.clientEmail.get(commande.client_id);
    if (!c) return;
    try {
      await courriel.envoyer({ a: c.email, sujet, texte: `Bonjour ${c.nom},\n\n${texte}\n\nCommande ${ref(commande.uuid)}.` });
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
    plaques.annulerPourCommande(commande.id);          // plaques pas encore imprimées : annulées
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
  const { connecte, verifie } = clients;

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
    const f = q.fichierDuClient.get(String(req.params.id), req.client.id);
    if (!f) return res.status(404).json({ erreur: 'fichier_inconnu' });
    lireStl(f, res, f.nom_origine);
  });

  // droit à l'effacement : impossible seulement pendant qu'une commande en a besoin
  rc.delete('/fichiers/:id', connecte, (req, res) => {
    const f = q.fichierDuClient.get(String(req.params.id), req.client.id);
    if (!f) return res.status(404).json({ erreur: 'fichier_inconnu' });
    const enCours = db.prepare(`SELECT 1 FROM devis_pieces p JOIN commande_devis cd ON cd.devis_id = p.devis_id
      JOIN commandes c ON c.id = cd.commande_id
      WHERE p.fichier_id = ? AND c.statut IN (${STATUTS_EN_COURS.map(() => '?').join(',')}) LIMIT 1`).get(f.id, ...STATUTS_EN_COURS);
    if (enCours) return res.status(409).json({ erreur: 'commande_en_cours', detail: 'ce fichier sert à une commande pas encore expédiée' });
    retirerPublicationsDuFichier(f.id);
    effacerFichier(f);
    journal('client.fichier.supprimer', { req, cible: `${req.client.email} ${f.nom_origine}`, resultat: 'ok' });
    res.json({ ok: true });
  });

  // ------------------------------------------------ devis

  const entier = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
  const reel = (v, min, max) => v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max);

  // nouveau devis en file pour la découpe. lignes : [fichier_id, quantite, pos_x, pos_y, rotation, echelle]
  function creerDevis(clientId, imp, { remp, couches, proprete_mm: propreteMm }, lignes, publicationId = null) {
    const now = Date.now();
    db.exec('BEGIN');
    try {
      const { lastInsertRowid: id } = db.prepare(`INSERT INTO devis (client_id, imprimante_id, remplissage_pct, couches_surface,
        proprete_mm, statut, cree_le, publication_id) VALUES (?, ?, ?, ?, ?, 'attente', ?, ?)`)
        .run(clientId, imp.id, remp, couches, propreteMm, now, publicationId);
      const ins = db.prepare(`INSERT INTO devis_pieces (devis_id, fichier_id, quantite, pos_x_mm, pos_y_mm, rotation_deg, echelle)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const l of lignes) ins.run(id, ...l);
      // un fichier utilisé dans un devis est gardé au moins 30 jours après ce devis
      db.prepare(`UPDATE fichiers_stl SET expire_le = max(expire_le, ?) WHERE id IN (SELECT fichier_id FROM devis_pieces WHERE devis_id = ?)`)
        .run(now + B.stlConservationJours * JOUR, id);
      db.exec('COMMIT');
      decoupeur.reveiller();
      return Number(id);
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  const devisEnCours = (clientId) => db.prepare("SELECT count(*) n FROM devis WHERE client_id = ? AND statut IN ('attente', 'decoupe')").get(clientId).n;

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
    if (devisEnCours(req.client.id) >= DEVIS_EN_ATTENTE_MAX) {
      return res.status(429).json({ erreur: 'trop_de_devis', detail: `${DEVIS_EN_ATTENTE_MAX} devis en cours de découpe au plus : attends qu'ils soient prêts` });
    }
    const lignes = [];
    const projets = new Map();          // publications dont viennent des pièces (ouvertes depuis la galerie)
    for (const p of pieces) {
      // pièce : un fichier du client (fichier_id) ou la pièce n d'un projet de la galerie (projet_id + piece)
      const { fichier_id: fid, projet_id: projetId, piece: n, quantite, pos_mm: pos, rotation_deg: rot, echelle = 1, ...trop } = p || {};
      let f = null;
      if (projetId !== undefined) {
        const r = fid === undefined ? pieceDuProjet(String(projetId), n) : null;
        if (!r) return res.status(400).json({ erreur: 'projet_inconnu', detail: String(projetId).slice(0, 40) });
        projets.set(r.pu.id, r.pu);
        f = q.fichier.get(r.p.fichier_id);
      } else if (uuidValide(fid)) f = q.fichierDuClient.get(fid, req.client.id);
      if (Object.keys(trop).length || !f || !f.chemin) return res.status(400).json({ erreur: 'fichier_inconnu', detail: String(fid).slice(0, 40) });
      if (!entier(quantite, 1, 50)) return res.status(400).json({ erreur: 'quantite_invalide', detail: '1 à 50' });
      if (pos !== undefined && (!Array.isArray(pos) || pos.length !== 2 || !reel(pos[0], -1000, 1000) || !reel(pos[1], -1000, 1000))) {
        return res.status(400).json({ erreur: 'position_invalide' });
      }
      if (!reel(rot, -360, 360)) return res.status(400).json({ erreur: 'rotation_invalide' });
      // multiplicateur de taille (STL exporté en mètres par Blender : x1000, en cm : x10, en pouces : x25,4)
      if (typeof echelle !== 'number' || !Number.isFinite(echelle) || echelle < 0.001 || echelle > 1000) {
        return res.status(400).json({ erreur: 'echelle_invalide', detail: 'multiplicateur de 0,001 à 1000' });
      }
      const dims = [f.dim_x_mm, f.dim_y_mm, f.dim_z_mm].map((v) => v * echelle);
      if (!tientSur(dims, imp)) {
        return res.status(400).json({ erreur: 'piece_trop_grande', detail: `${f.nom_origine} ne tient pas sur ${imp.nom}` });
      }
      if (Math.max(...dims) < 1) {
        return res.status(400).json({ erreur: 'piece_trop_petite', detail: `${f.nom_origine} fait moins d'1 mm : augmente le multiplicateur de taille` });
      }
      lignes.push([f.id, quantite, pos?.[0] ?? null, pos?.[1] ?? null, rot ?? 0, echelle]);
    }
    // devis avec des pièces d'un projet : relié au (premier) projet, ce qui empêche aussi de le republier comme le sien
    const [premier] = projets.values();
    const id = creerDevis(req.client.id, imp, { remp, couches, proprete_mm: PROPRETES[proprete] }, lignes, premier?.id ?? null);
    for (const pu of projets.values()) db.prepare('UPDATE publications SET choisie = choisie + 1 WHERE id = ?').run(pu.id);
    journal('client.devis', { req, cible: `${req.client.email} devis ${id}`, resultat: 'ok',
      detail: `${lignes.length} pièce(s)${projets.size ? `, projet(s) ${[...projets.values()].map((pu) => pu.uuid).join(' ')}` : ''}` });
    res.status(201).json(devisComplet(db.prepare('SELECT * FROM devis WHERE id = ?').get(id)));
  });

  rc.get('/devis', connecte, (req, res) => {
    res.json(db.prepare('SELECT * FROM devis WHERE client_id = ? ORDER BY id DESC LIMIT 100').all(req.client.id).map(devisComplet));
  });

  rc.get('/devis/:id', connecte, (req, res) => {
    const d = q.devisDuClient.get(String(req.params.id), req.client.id);
    if (!d) return res.status(404).json({ erreur: 'devis_inconnu' });
    res.json(devisComplet(d));
  });

  // suppression d'un devis par son client : le devis, ses fichiers STL (base + disque) et son gcode.
  // Un STL utilisé aussi par un autre devis est gardé pour celui-ci. Impossible une fois le devis commandé
  // (paiement en cours ou fait : le gcode sert à l'impression) ou pendant sa découpe.
  rc.delete('/devis/:id', connecte, (req, res) => {
    const d = q.devisDuClient.get(String(req.params.id), req.client.id);
    if (!d) return res.status(404).json({ erreur: 'devis_inconnu' });
    if (d.statut === 'decoupe') return res.status(409).json({ erreur: 'decoupe_en_cours' });
    const c = q.commandeDuDevis.get(d.id);
    if (c && c.statut !== 'abandonnee') return res.status(409).json({ erreur: 'devis_commande', detail: `commande ${c.id}` });

    const fichiers = db.prepare('SELECT DISTINCT f.* FROM devis_pieces p JOIN fichiers_stl f ON f.id = p.fichier_id WHERE p.devis_id = ? AND f.client_id = ?')
      .all(d.id, d.client_id);
    db.exec('BEGIN');
    try {
      // commande jamais payée (abandonnée) : elle part avec le devis ; ses autres devis redeviennent libres
      if (c) supprimerCommandeNonPayee(c.id);
      db.prepare('DELETE FROM devis WHERE id = ?').run(d.id);           // devis_pieces : supprimées avec lui
      for (const f of fichiers) {
        if (!db.prepare('SELECT 1 FROM devis_pieces WHERE fichier_id = ? LIMIT 1').get(f.id)) {
          db.prepare('DELETE FROM fichiers_stl WHERE id = ?').run(f.id);
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    // fichiers sur le disque : seulement après la suppression en base (rien d'effacé si elle a échoué)
    for (const f of fichiers) if (!q.fichier.get(f.id)) supprimerFichierDisque(f);
    decoupeur.effacer(d.id);
    journal('client.devis.supprimer', { req, cible: `${req.client.email} devis ${d.id}`, resultat: 'ok', detail: `${fichiers.length} fichier(s)` });
    res.json({ ok: true });
  });

  // découpe en erreur (panne passagère d'Orca, par ex.) : le client la relance sans tout redéposer
  rc.post('/devis/:id/relancer', connecte, (req, res) => {
    const d = q.devisDuClient.get(String(req.params.id), req.client.id);
    if (!d) return res.status(404).json({ erreur: 'devis_inconnu' });
    if (d.statut !== 'erreur') return res.status(409).json({ erreur: 'devis_pas_en_erreur' });
    const absent = db.prepare(`SELECT f.nom_origine FROM devis_pieces p JOIN fichiers_stl f ON f.id = p.fichier_id
      WHERE p.devis_id = ? AND f.chemin = '' LIMIT 1`).get(d.id);
    if (absent) return res.status(409).json({ erreur: 'fichier_indisponible', detail: absent.nom_origine });
    if (devisEnCours(req.client.id) >= DEVIS_EN_ATTENTE_MAX) {
      return res.status(429).json({ erreur: 'trop_de_devis', detail: `${DEVIS_EN_ATTENTE_MAX} devis en cours de découpe au plus : attends qu'ils soient prêts` });
    }
    db.prepare("UPDATE devis SET statut = 'attente', erreur = NULL WHERE id = ?").run(d.id);
    decoupeur.reveiller();
    journal('client.devis.relancer', { req, cible: `${req.client.email} devis ${d.id}`, resultat: 'ok' });
    res.json(devisComplet(db.prepare('SELECT * FROM devis WHERE id = ?').get(d.id)));
  });

  // aperçu 3D du gcode découpé par le serveur (le gcode lui-même n'est jamais envoyé au client)
  const devisDuClient = (req, res) => {
    const d = q.devisDuClient.get(String(req.params.id), req.client.id);
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
    res.json(db.prepare('SELECT uuid id, nom_complet, ligne1, ligne2, code_postal, ville, pays, telephone FROM adresses WHERE client_id = ? ORDER BY id DESC')
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
    res.status(201).json({ id: db.prepare('SELECT uuid FROM adresses WHERE id = ?').get(lastInsertRowid).uuid });
  });

  rc.delete('/adresses/:id', connecte, (req, res) => {
    const n = db.prepare('DELETE FROM adresses WHERE uuid = ? AND client_id = ?').run(String(req.params.id), req.client.id).changes;
    res.status(n ? 200 : 404).json(n ? { ok: true } : { erreur: 'adresse_inconnue' });
  });

  // ------------------------------------------------ commandes

  // ---- commandes groupées : plusieurs devis payés ensemble, une seule livraison (sur le poids total)
  const DEVIS_PAR_COMMANDE_MAX = 5;

  // devis demandés -> { liste } ou { statut, json } (erreur à renvoyer)
  // ids : identifiants publics (UUID) des devis du client
  function devisCommandables(clientId, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > DEVIS_PAR_COMMANDE_MAX || !ids.every(uuidValide)
      || new Set(ids).size !== ids.length) {
      return { statut: 400, json: { erreur: 'devis_invalides', detail: `1 à ${DEVIS_PAR_COMMANDE_MAX} devis différents` } };
    }
    const liste = [];
    for (const uuid of ids) {
      const d = q.devisDuClient.get(uuid, clientId);
      if (!d) return { statut: 404, json: { erreur: 'devis_inconnu', detail: `devis ${ref(uuid)}` } };
      if (d.statut !== 'pret' || d.prix_matiere_cts == null) return { statut: 409, json: { erreur: 'devis_pas_pret', detail: `devis ${ref(uuid)}` } };
      const c = q.commandeDuDevis.get(d.id);
      if (c && !['en_attente_paiement', 'abandonnee'].includes(c.statut)) {
        return { statut: 409, json: { erreur: 'deja_commandee', detail: `devis ${ref(uuid)} : commande ${ref(c.uuid)}` } };
      }
      liste.push(d);
    }
    return { liste };
  }

  // montant d'une commande : matière de chaque devis + UNE livraison calculée sur le poids total
  function montant(liste) {
    const poids = liste.reduce((t, d) => t + d.poids_g, 0);
    const sousTotal = liste.reduce((t, d) => t + d.prix_matiere_cts, 0);
    const livraison = prixLivraison(B, poids);
    const separees = liste.reduce((t, d) => t + d.livraison_cts, 0);
    return { poids_g: Math.round(poids * 100) / 100, sous_total_cts: sousTotal, livraison_cts: livraison, total_cts: sousTotal + livraison,
      economie_livraison_cts: Math.max(0, separees - livraison) };
  }

  // commande jamais payée : supprimée (ses devis redeviennent libres ; les événements Stripe gardent leur trace)
  function supprimerCommandeNonPayee(id) {
    db.prepare('UPDATE evenements_stripe SET commande_id = NULL WHERE commande_id = ?').run(id);
    db.prepare("DELETE FROM commandes WHERE id = ? AND statut IN ('en_attente_paiement', 'abandonnee')").run(id);
  }

  const idsDemandes = (texte) => String(texte || '').split(',').filter(Boolean).slice(0, DEVIS_PAR_COMMANDE_MAX + 1);

  // aperçu du montant avant de payer (page d'achat) : calculé ici, jamais dans le navigateur
  rc.get('/commandes/estimation', connecte, (req, res) => {
    const r = devisCommandables(req.client.id, idsDemandes(req.query.devis));
    if (!r.liste) return res.status(r.statut).json(r.json);
    res.json({ ...montant(r.liste), devis: r.liste.map(devisComplet) });
  });

  // commander un ou plusieurs devis découpés : le montant vient des devis (calculés par le serveur), jamais du
  // navigateur. Retourne l'adresse de la page de paiement Stripe.
  rc.post('/commandes', verifie, asynchrone(async (req, res) => {
    const { devis_id: unSeul, devis_ids: plusieurs, adresse_id: adresseId, ...reste } = req.body || {};
    if (Object.keys(reste).length) return res.status(400).json({ erreur: 'champ_inconnu' });
    const r = devisCommandables(req.client.id, plusieurs !== undefined ? plusieurs : [unSeul]);
    if (!r.liste) return res.status(r.statut).json(r.json);
    const a = uuidValide(adresseId) ? q.adresseDuClient.get(adresseId, req.client.id) : null;
    if (!a) return res.status(400).json({ erreur: 'adresse_inconnue' });
    if (!paiements.configure) return res.status(503).json({ erreur: 'paiement_non_configure' });

    // nouvel essai de paiement : les commandes pas payées qui contenaient ces devis sont fermées chez Stripe
    // (pas de double paiement) puis supprimées ; leurs autres devis redeviennent libres
    const anciennes = new Map();
    for (const d of r.liste) { const c = q.commandeDuDevis.get(d.id); if (c) anciennes.set(c.id, c); }
    for (const c of anciennes.values()) {
      if (c.stripe_session_id && c.statut === 'en_attente_paiement') await paiements.expirerSession(c.stripe_session_id).catch(() => {});
      supprimerCommandeNonPayee(c.id);
    }

    const m = montant(r.liste);
    const adresse = JSON.stringify({ ligne1: a.ligne1, ligne2: a.ligne2, code_postal: a.code_postal, ville: a.ville,
      pays: a.pays, telephone: a.telephone });
    const now = Date.now();
    let id;
    db.exec('BEGIN');
    try {
      id = Number(db.prepare(`INSERT INTO commandes (client_id, devis_id, livraison_nom, livraison_adresse, sous_total_cts,
        livraison_cts, total_cts, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(req.client.id, r.liste[0].id, a.nom_complet, adresse, m.sous_total_cts, m.livraison_cts, m.total_cts, now).lastInsertRowid);
      const lier = db.prepare('INSERT OR IGNORE INTO commande_devis (commande_id, devis_id) VALUES (?, ?)');
      for (const d of r.liste) lier.run(id, d.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    try {
      const s = await paiements.creerSession({ commande: q.commande.get(id), email: req.client.email, devis: r.liste,
        urlSite: B.urlSite.replace(/\/+$/, '') });
      db.prepare('UPDATE commandes SET stripe_session_id = ? WHERE id = ?').run(s.id, id);
      journal('client.commande', { req, cible: `${req.client.email} commande ${id}`, resultat: 'ok',
        detail: `${r.liste.length} devis, ${m.total_cts} cts` });
      res.status(201).json({ commande_id: q.commande.get(id).uuid, url: s.url });
    } catch (e) {
      if (!(e instanceof ErreurPaiement)) throw e;
      console.error(`[stripe] commande ${id} : ${e.message}`);
      res.status(503).json({ erreur: 'paiement_indisponible' });
    }
  }));

  rc.get('/commandes', connecte, (req, res) => {
    res.json(db.prepare('SELECT * FROM commandes WHERE client_id = ? ORDER BY id DESC LIMIT 100').all(req.client.id).map(commandePublique));
  });

  rc.get('/commandes/:id', connecte, (req, res) => {
    const c = q.commandeDuClient.get(String(req.params.id), req.client.id);
    if (!c) return res.status(404).json({ erreur: 'commande_inconnue' });
    res.json({ ...commandePublique(c), devis: devisComplet(db.prepare('SELECT * FROM devis WHERE id = ?').get(c.devis_id)),
      devis_liste: idsDevis(c.id).map((id) => devisComplet(db.prepare('SELECT * FROM devis WHERE id = ?').get(id))) });
  });

  // ------------------------------------------------ galerie des projets réalisés
  // Un client publie un de ses projets dès que l'admin a validé sa commande (pas besoin d'attendre l'impression),
  // signé de son pseudo, et peut le retirer à tout moment. Les autres le voient en 3D (aperçu du gcode) et :
  //  - le choisissent tel quel : un devis à leur nom est découpé avec les mêmes pièces et réglages ;
  //  - ou l'ouvrent dans l'atelier (publications avec partage_stl) : ses STL s'affichent sur leur plateau, ils
  //    changent quantités, taille et réglages, puis découpent ; le devis désigne les pièces par projet + numéro.
  // Une commande remboursée (refusée, jamais envoyée) retire son projet de la galerie.

  const STATUTS_PUBLIABLES = ['validee', 'dans_un_lot', 'en_impression', 'suspendue', 'imprimee', 'expediee', 'livree'];
  const PUBLICATION_VISIBLE = `SELECT pu.*, c.pseudo FROM publications pu JOIN clients c ON c.id = pu.client_id
    JOIN devis d ON d.id = pu.devis_id WHERE pu.retiree_le IS NULL AND c.actif = 1 AND c.pseudo IS NOT NULL AND d.statut = 'pret'
    AND NOT EXISTS (SELECT 1 FROM commande_devis cd JOIN commandes co ON co.id = cd.commande_id
      WHERE cd.devis_id = d.id AND co.statut = 'remboursee')`;
  const piecesDuProjet = (devisId) => db.prepare(`SELECT p.*, f.nom_origine, f.dim_x_mm, f.dim_y_mm, f.dim_z_mm, f.chemin
    FROM devis_pieces p JOIN fichiers_stl f ON f.id = p.fichier_id WHERE p.devis_id = ? ORDER BY p.id`).all(devisId);

  function retirerPublicationsDuFichier(fichierId) {
    db.prepare(`UPDATE publications SET retiree_le = ? WHERE retiree_le IS NULL AND devis_id IN (
      SELECT devis_id FROM devis_pieces WHERE fichier_id = ?)`).run(Date.now(), fichierId);
  }

  // projet vu dans la galerie : ce qu'il faut pour choisir (pièces, tailles, réglages, poids), rien de privé
  function projetPublic(pu) {
    const d = db.prepare('SELECT * FROM devis WHERE id = ?').get(pu.devis_id);
    const pieces = piecesDuProjet(d.id);
    return { id: pu.uuid, titre: pu.titre, auteur: pu.pseudo, cree_le: pu.cree_le, choisie: pu.choisie,
      imprimante_id: d.imprimante_id, poids_g: d.poids_g, duree_s: d.duree_s, prix_matiere_cts: d.prix_matiere_cts,
      reglages: { remplissage_pct: d.remplissage_pct, couches_surface: d.couches_surface, proprete: d.proprete_mm === 0.2 ? 'fine' : 'rapide' },
      disponible: pieces.every((p) => p.chemin),
      ajustable: !!pu.partage_stl,          // peut s'ouvrir dans l'atelier (STL partagés)
      pieces: pieces.map((p, i) => ({ n: i + 1, nom: p.nom_origine.replace(/\.stl$/i, ''), quantite: p.quantite, echelle: p.echelle,
        dims_mm: [p.dim_x_mm, p.dim_y_mm, p.dim_z_mm].map((v) => Math.round(v * p.echelle * 10) / 10) })) };
  }
  const publicationVisible = (uuid) => (uuidValide(uuid) ? db.prepare(`${PUBLICATION_VISIBLE} AND pu.uuid = ?`).get(uuid) : null);

  // pièce n (à partir de 1) d'un projet ouvrable dans l'atelier -> ligne devis_pieces + fichier, ou null
  function pieceDuProjet(uuid, n) {
    const pu = publicationVisible(uuid);
    if (!pu || !pu.partage_stl || !Number.isInteger(n) || n < 1) return null;
    const p = piecesDuProjet(pu.devis_id)[n - 1];
    return p && p.chemin ? { pu, p } : null;
  }

  // ouverte à tous (même sans compte) : la vitrine du site
  rc.get('/galerie', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.json(db.prepare(`${PUBLICATION_VISIBLE} ORDER BY pu.cree_le DESC LIMIT 120`).all().map(projetPublic));
  });
  rc.get('/galerie/:id/trajets', (req, res) => {
    const pu = publicationVisible(String(req.params.id));
    if (!pu) return res.status(404).json({ erreur: 'projet_inconnu' });
    envoyerTrajets(res, pu.devis_id, 'meta');
  });
  rc.get('/galerie/:id/trajets-bin', (req, res) => {
    const pu = publicationVisible(String(req.params.id));
    if (!pu) return res.status(404).json({ erreur: 'projet_inconnu' });
    envoyerTrajets(res, pu.devis_id, 'bin');
  });

  // STL d'une pièce d'un projet ouvrable dans l'atelier (affichage et ajustement dans le navigateur du visiteur)
  const limiteStlGalerie = rateLimit({ windowMs: 3600e3, limit: 200, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { erreur: 'trop_de_requetes' } });
  rc.get('/galerie/:id/pieces/:n', limiteStlGalerie, (req, res) => {
    const r = pieceDuProjet(String(req.params.id), Number(req.params.n));
    if (!r) return res.status(404).json({ erreur: 'projet_inconnu' });
    res.set({ 'Content-Type': 'model/stl', 'Cache-Control': 'private, max-age=600' });
    fs.createReadStream(path.join(config.donnees, r.p.chemin)).pipe(zlib.createGunzip()).on('error', () => res.destroy()).pipe(res);
  });

  // choisir un projet : devis à son nom, mêmes pièces et réglages, découpé à nouveau (profil d'impression actuel)
  rc.post('/galerie/:id/devis', connecte, (req, res) => {
    const pu = publicationVisible(String(req.params.id));
    if (!pu) return res.status(404).json({ erreur: 'projet_inconnu' });
    const source = db.prepare('SELECT * FROM devis WHERE id = ?').get(pu.devis_id);
    const imp = q.imprimante.get(source.imprimante_id);
    if (!imp?.disponible) return res.status(409).json({ erreur: 'imprimante_indisponible' });
    const pieces = db.prepare(`SELECT p.*, f.chemin FROM devis_pieces p JOIN fichiers_stl f ON f.id = p.fichier_id
      WHERE p.devis_id = ? ORDER BY p.id`).all(source.id);
    if (pieces.some((p) => !p.chemin)) return res.status(409).json({ erreur: 'projet_indisponible' });
    if (devisEnCours(req.client.id) >= DEVIS_EN_ATTENTE_MAX) {
      return res.status(429).json({ erreur: 'trop_de_devis', detail: `${DEVIS_EN_ATTENTE_MAX} devis en cours de découpe au plus : attends qu'ils soient prêts` });
    }
    const id = creerDevis(req.client.id, imp, { remp: source.remplissage_pct, couches: source.couches_surface, proprete_mm: source.proprete_mm },
      pieces.map((p) => [p.fichier_id, p.quantite, p.pos_x_mm, p.pos_y_mm, p.rotation_deg, p.echelle]), pu.id);
    db.prepare('UPDATE publications SET choisie = choisie + 1 WHERE id = ?').run(pu.id);
    journal('client.galerie.choix', { req, cible: `${req.client.email} devis ${id}`, resultat: 'ok', detail: `projet ${pu.uuid}` });
    res.status(201).json(devisComplet(db.prepare('SELECT * FROM devis WHERE id = ?').get(id)));
  });

  // ses publications (visibles ou retirées)
  rc.get('/publications', connecte, (req, res) => {
    res.json(db.prepare(`SELECT pu.*, d.uuid devis_uuid FROM publications pu JOIN devis d ON d.id = pu.devis_id
      WHERE pu.client_id = ? ORDER BY pu.cree_le DESC`).all(req.client.id).map((pu) => ({ id: pu.uuid, titre: pu.titre,
      devis_id: pu.devis_uuid, devis_ref: ref(pu.devis_uuid), cree_le: pu.cree_le, retiree_le: pu.retiree_le, choisie: pu.choisie })));
  });

  // publier un projet dont la commande est validée (ou le republier après l'avoir retiré). Publier vaut accord
  // pour que les visiteurs ouvrent ses STL dans leur atelier (dit au client sur le formulaire de publication).
  rc.post('/devis/:id/publier', connecte, (req, res) => {
    const { titre, ...reste } = req.body || {};
    if (Object.keys(reste).length) return res.status(400).json({ erreur: 'champ_inconnu' });
    if (typeof titre !== 'string' || !titre.trim() || titre.length > 60) return res.status(400).json({ erreur: 'titre_invalide', detail: '1 à 60 caractères' });
    const d = q.devisDuClient.get(String(req.params.id), req.client.id);
    if (!d) return res.status(404).json({ erreur: 'devis_inconnu' });
    if (d.publication_id) return res.status(409).json({ erreur: 'projet_d_un_autre', detail: 'ce devis vient de la galerie' });
    const c = q.commandeDuDevis.get(d.id);
    if (d.statut !== 'pret' || !c || !STATUTS_PUBLIABLES.includes(c.statut)) return res.status(409).json({ erreur: 'pas_encore_valide' });
    if (!req.client.pseudo) return res.status(409).json({ erreur: 'pseudo_requis' });
    const absent = db.prepare(`SELECT 1 FROM devis_pieces p JOIN fichiers_stl f ON f.id = p.fichier_id WHERE p.devis_id = ? AND f.chemin = ''`).get(d.id);
    if (absent) return res.status(409).json({ erreur: 'fichier_indisponible' });
    db.prepare(`INSERT INTO publications (client_id, devis_id, titre, cree_le, partage_stl) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(devis_id) DO UPDATE SET titre = excluded.titre, retiree_le = NULL, cree_le = excluded.cree_le, partage_stl = 1`)
      .run(req.client.id, d.id, titre.trim(), Date.now());
    journal('client.galerie.publier', { req, cible: `${req.client.email} devis ${d.id}`, resultat: 'ok' });
    res.status(201).json(projetPublic(db.prepare(`${PUBLICATION_VISIBLE} AND pu.devis_id = ?`).get(d.id)));
  });

  rc.delete('/publications/:id', connecte, (req, res) => {
    const n = db.prepare('UPDATE publications SET retiree_le = ? WHERE uuid = ? AND client_id = ? AND retiree_le IS NULL')
      .run(Date.now(), String(req.params.id), req.client.id).changes;
    if (!n) return res.status(404).json({ erreur: 'publication_inconnue' });
    journal('client.galerie.retirer', { req, cible: req.client.email, resultat: 'ok' });
    res.json({ ok: true });
  });

  // ------------------------------------------------ suppression du compte (droit à l'effacement)
  // Mot de passe redemandé. Impossible pendant une commande en cours. Effacés : publications, devis non
  // commandés, fichiers STL (disque), adresses, sessions ; le compte est anonymisé. Les commandes passées et
  // leurs factures restent (obligation comptable), avec le nom et l'adresse de livraison qui y figurent.
  rc.delete('/moi', connecte, asynchrone(async (req, res) => {
    const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.client.id);
    if (typeof req.body?.motdepasse !== 'string' || !(await S.verifierMdp(c.hash, req.body.motdepasse))) {
      return res.status(401).json({ erreur: 'mot_de_passe_invalide' });
    }
    const enCours = db.prepare(`SELECT 1 FROM commandes WHERE client_id = ? AND statut IN (${STATUTS_EN_COURS.map(() => '?').join(',')}) LIMIT 1`)
      .get(c.id, ...STATUTS_EN_COURS);
    if (enCours) return res.status(409).json({ erreur: 'commande_en_cours', detail: 'attends la livraison de ta commande' });
    const now = Date.now();
    const libres = db.prepare('SELECT id FROM devis WHERE client_id = ? AND id NOT IN (SELECT devis_id FROM commande_devis)').all(c.id);
    const fichiers = db.prepare("SELECT * FROM fichiers_stl WHERE client_id = ? AND chemin != ''").all(c.id);
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE publications SET retiree_le = ? WHERE client_id = ? AND retiree_le IS NULL').run(now, c.id);
      for (const { id } of db.prepare("SELECT id FROM commandes WHERE client_id = ? AND statut IN ('en_attente_paiement', 'abandonnee')").all(c.id)) {
        supprimerCommandeNonPayee(id);
      }
      for (const { id } of libres) db.prepare('DELETE FROM devis WHERE id = ?').run(id);
      db.prepare('DELETE FROM adresses WHERE client_id = ?').run(c.id);
      db.prepare('DELETE FROM jetons_email WHERE client_id = ?').run(c.id);
      db.prepare('DELETE FROM sessions_client WHERE client_id = ?').run(c.id);
      db.prepare(`UPDATE clients SET email = ?, nom = 'Compte supprimé', pseudo = NULL, hash = '!', actif = 0, email_verifie = 0
        WHERE id = ?`).run(`supprime-${crypto.randomUUID()}@compte-supprime.invalid`, c.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    for (const { id } of libres) decoupeur.effacer(id);
    for (const f of fichiers) effacerFichier(f);
    journal('client.suppression_compte', { req, cible: `client ${c.id}`, resultat: 'ok', detail: `${fichiers.length} fichier(s), ${libres.length} devis` });
    res.append('Set-Cookie', `${clients.NOM}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.api.cookieSecure ? '; Secure' : ''}`);
    res.json({ ok: true });
  }));

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
      paiement_mode: paiements.mode,
      courriel: courriel.mode,
    });
  });

  ra.get('/commandes', (req, res) => {
    const statuts = String(req.query.statut || '').split(',').filter(Boolean);
    const filtre = statuts.length ? `WHERE c.statut IN (${statuts.map(() => '?').join(',')})` : '';
    res.json(db.prepare(`SELECT c.*, cl.email client_email, cl.nom client_nom,
        (SELECT coalesce(sum(quantite), 0) FROM devis_pieces WHERE devis_id IN (SELECT devis_id FROM commande_devis WHERE commande_id = c.id)) nb_pieces
      FROM commandes c JOIN clients cl ON cl.id = c.client_id ${filtre}
      ORDER BY coalesce(c.paye_le, c.cree_le) ASC LIMIT 500`).all(...statuts).map((c) => ({
      ...commandePublique(c, { admin: true }), client: { id: c.client_id, email: c.client_email, nom: c.client_nom }, nb_pieces: c.nb_pieces,
      validation_limite_le: c.validation_limite_le, valide_le: c.valide_le, suspendue_le: c.suspendue_le,
      motif_refus: c.motif_refus, rembourse_par: c.rembourse_par,
    })));
  });

  ra.get('/commandes/:id', (req, res) => {
    const c = q.commande.get(Number(req.params.id));
    if (!c) return res.status(404).json({ erreur: 'commande_inconnue' });
    const cl = db.prepare('SELECT id, email, nom FROM clients WHERE id = ?').get(c.client_id);
    res.json({ ...commandePublique(c, { admin: true }), client: cl, validation_limite_le: c.validation_limite_le, valide_le: c.valide_le,
      motif_refus: c.motif_refus, rembourse_par: c.rembourse_par,
      devis: devisComplet(db.prepare('SELECT * FROM devis WHERE id = ?').get(c.devis_id), { admin: true }),
      devis_liste: idsDevis(c.id).map((id) => devisComplet(db.prepare('SELECT * FROM devis WHERE id = ?').get(id), { admin: true })),
      facture: db.prepare('SELECT numero, total_cts, emise_le FROM factures WHERE commande_id = ?').get(c.id) || null,
      plaques: plaques.deLaCommande(c.id),
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
    // ses plaques (une par devis) partent dans le dossier « a_faire » de l'imprimante
    const creees = plaques.creerPourCommande(c.id);
    journal('boutique.valider', { req, cible: `commande ${c.id}`, resultat: 'ok', detail: `${creees.length} plaque(s)` });
    res.json({ ok: true, envoi_limite_le: limite, plaques: creees.map(plaques.numero) });
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

  // plaques : liste, à valider (pop-up), valider / ratée / lancer / renvoyer
  ra.use('/plaques', plaques.routes);

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
    // un devis précis de la commande (commande groupée), sinon le premier
    const devisId = req.params.devis === undefined ? c.devis_id : Number(req.params.devis);
    if (!idsDevis(c.id).includes(devisId)) { res.status(404).json({ erreur: 'devis_inconnu' }); return null; }
    const d = db.prepare('SELECT * FROM devis WHERE id = ?').get(devisId);
    if (!d?.gcode_chemin || !fs.existsSync(path.join(config.donnees, d.gcode_chemin))) {
      res.status(404).json({ erreur: 'gcode_absent' });
      return null;
    }
    return { c, d };
  };

  // /commandes/:id/gcode (premier devis) ou /commandes/:id/devis/:devis/gcode (commande groupée)
  for (const base of ['/commandes/:id/gcode', '/commandes/:id/devis/:devis/gcode']) {
    ra.get(base, (req, res) => {
      const r = commandeAvecGcode(req, res);
      if (!r) return;
      journal('boutique.gcode.lire', { req, cible: `commande ${r.c.id} devis ${r.d.id}`, resultat: 'ok' });
      const nom = idsDevis(r.c.id).length > 1 ? `commande-${r.c.id}-devis-${r.d.id}` : `commande-${r.c.id}`;
      res.set({ 'Content-Type': 'text/x-gcode; charset=utf-8', 'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="${nom}.gcode"` });
      fs.createReadStream(path.join(config.donnees, r.d.gcode_chemin)).pipe(zlib.createGunzip()).on('error', () => res.destroy()).pipe(res);
    });
    // même format que l'aperçu des fichiers de l'imprimante (visualiseur apercu3d.js de l'admin)
    ra.get(`${base}/toolpath`, (req, res) => {
      const r = commandeAvecGcode(req, res);
      if (r) envoyerTrajets(res, r.d.id, 'meta');
    });
    ra.get(`${base}/toolpath-bin`, (req, res) => {
      const r = commandeAvecGcode(req, res);
      if (r) envoyerTrajets(res, r.d.id, 'bin');
    });
  }

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
    const vieux = db.prepare('SELECT id FROM devis WHERE cree_le < ? AND id NOT IN (SELECT devis_id FROM commande_devis)')
      .all(maintenant - B.stlConservationJours * JOUR);
    for (const { id } of vieux) {
      decoupeur.effacer(id);
      bilan.devis_supprimes += db.prepare('DELETE FROM devis WHERE id = ?').run(id).changes;
    }
    for (const f of db.prepare(`SELECT * FROM fichiers_stl WHERE expire_le < ? AND chemin != '' AND id NOT IN (
      SELECT p.fichier_id FROM devis_pieces p JOIN publications pu ON pu.devis_id = p.devis_id WHERE pu.retiree_le IS NULL)`).all(maintenant)) {
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

  // ================================================================ webhook Stripe (/api/stripe/webhook)

  async function webhookStripe(req, res) {
    let ev;
    try {
      ev = paiements.lireWebhook(req.body, req.headers['stripe-signature']);
    } catch (e) {
      journal('stripe.webhook', { req, resultat: 'refuse', detail: e.detail || e.code });
      return res.status(400).json({ erreur: e.code });
    }
    const o = ev.data?.object || {};
    const c = q.commande.get(Number(o.metadata?.commande_id || o.client_reference_id) || 0);
    // un même événement n'est jamais traité deux fois (Stripe peut le renvoyer)
    const nouveau = db.prepare('INSERT OR IGNORE INTO evenements_stripe (id, commande_id, type, recu_le) VALUES (?, ?, ?, ?)')
      .run(String(ev.id), c?.id ?? null, String(ev.type), Date.now()).changes;
    if (!nouveau) return res.json({ recu: true });

    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(ev.type) && o.payment_status === 'paid') {
      // tout doit correspondre à la commande : session, montant, devise
      if (!c || c.stripe_session_id !== o.id || o.amount_total !== c.total_cts || o.currency !== 'eur') {
        console.error(`[stripe] paiement ${o.id} ne correspond à aucune commande (commande ${c?.id ?? '?'}, ${o.amount_total} ${o.currency})`);
        journal('stripe.anomalie', { cible: `session ${o.id}`, resultat: 'erreur', detail: `commande ${c?.id ?? '?'}` });
        await prevenirAdmins('Paiement Stripe à vérifier', `Un paiement Stripe (session ${o.id}, ${o.amount_total} ${o.currency}) ne correspond `
          + `à aucune commande en attente (commande ${c?.id ?? 'inconnue'}). Vérifie-le dans le tableau de bord Stripe et rembourse-le si besoin.`);
        return res.json({ recu: true });
      }
      if (marquerPayee(c.id, o.payment_intent)) {
        const f = emettreFacture(c);
        const limite = q.commande.get(c.id).validation_limite_le;
        journal('boutique.paiement', { cible: `commande ${c.id}`, resultat: 'ok', detail: `${c.total_cts} cts, facture ${f.numero}` });
        await prevenirClient(c, 'Paiement reçu, merci !', `Nous avons bien reçu ton paiement de ${euros(c.total_cts)} (facture ${f.numero}).\n`
          + 'Nous vérifions ta commande puis l\'imprimons : expédition sous 2 semaines en général, 2 mois au plus. '
          + 'Tu recevras un e-mail à chaque étape.');
        await prevenirAdmins(`Nouvelle commande payée n° ${c.id}`, `Commande n° ${c.id} payée : ${euros(c.total_cts)} (facture ${f.numero}).\n`
          + `À valider avant le ${new Date(limite).toLocaleDateString('fr-FR')}, sinon elle sera remboursée automatiquement.`);
      }
    } else if (ev.type === 'checkout.session.expired' && c) {
      db.prepare("UPDATE commandes SET statut = 'abandonnee' WHERE id = ? AND statut = 'en_attente_paiement' AND stripe_session_id = ?")
        .run(c.id, o.id);
    }
    res.json({ recu: true });
  }

  return { routesClient: rc, routesAdmin: ra, plaques, tacheHoraire, marquerPayee, planifierRappels, enregistrerStl, decoupeur, webhookStripe,
    emettreFacture };
}

module.exports = { creerBoutique, prixLivraison, prixMatiere, datesRappels };
