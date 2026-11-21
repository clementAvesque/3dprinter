'use strict';
// Découpe des devis par OrcaSlicer (ligne de commande), un devis à la fois.
//
// devis « attente » -> « decoupe » -> « pret » (poids, durée, prix, gcode, aperçu) ou « erreur ».
// Le gcode n'est produit QUE par le serveur, à partir des STL vérifiés et des réglages bornés du devis :
// le navigateur du client n'envoie jamais de gcode, et c'est ce gcode-là que l'admin reçoit.
//
// Fichiers (dossier de données) :  gcode/devis-<id>.gcode.gz   gcode compressé
//                                  gcode/devis-<id>.trajets.json + .trajets.bin.gz   aperçu 3D
// Profils Orca : serveur/orca/<profil_orca>/{machine,process,filament}.json (scripts/orca_profils.py)

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { lireGcode } = require('./trajets');

// réglage « propreté » du devis -> hauteur de couche et lissage envoyés à Orca.
// « rapide » est stocké 0.4 (valeur d'origine de la conception) mais la Kobra 3 0.4 mm accepte 0.28 mm au plus.
const COUCHES = { 0.2: { layer_height: '0.2', ironing_type: 'top' }, 0.4: { layer_height: '0.28', ironing_type: 'no ironing' } };

const fichiersDevis = (dossier, id) => ({
  gcode: path.join(dossier, `devis-${id}.gcode.gz`),
  meta: path.join(dossier, `devis-${id}.trajets.json`),
  bin: path.join(dossier, `devis-${id}.trajets.bin.gz`),
});

function creerDecoupeur({ config, db, calculerPrix }) {
  const O = config.orca;
  const commande = Array.isArray(O.commande) ? O.commande : String(O.commande || '').split(/\s+/).filter(Boolean);
  const dossierGcode = path.join(config.donnees, 'gcode');
  const dossierTravail = path.join(config.donnees, 'decoupe');
  fs.mkdirSync(dossierGcode, { recursive: true });

  const q = {
    suivant: db.prepare("SELECT * FROM devis WHERE statut = 'attente' ORDER BY id LIMIT 1"),
    prendre: db.prepare("UPDATE devis SET statut = 'decoupe', erreur = NULL, decoupe_debut_le = ? WHERE id = ? AND statut = 'attente'"),
    triangles: db.prepare(`SELECT coalesce(sum(f.triangles * p.quantite), 0) n FROM devis_pieces p
      JOIN fichiers_stl f ON f.id = p.fichier_id WHERE p.devis_id = ?`),
    historique: db.prepare(`SELECT (d.decoupe_le - d.decoupe_debut_le) / 1000.0 duree,
        (SELECT sum(f.triangles * p.quantite) FROM devis_pieces p JOIN fichiers_stl f ON f.id = p.fichier_id WHERE p.devis_id = d.id) triangles
      FROM devis d WHERE d.statut = 'pret' AND d.decoupe_debut_le IS NOT NULL ORDER BY d.decoupe_le DESC LIMIT 20`),
    devant: db.prepare("SELECT id, statut, decoupe_debut_le FROM devis WHERE statut = 'decoupe' OR (statut = 'attente' AND id < ?)"),
    pieces: db.prepare(`SELECT p.quantite, f.chemin, f.nom_origine FROM devis_pieces p JOIN fichiers_stl f ON f.id = p.fichier_id
      WHERE p.devis_id = ? ORDER BY p.id`),
    imprimante: db.prepare('SELECT * FROM imprimantes WHERE id = ?'),
    pret: db.prepare(`UPDATE devis SET statut = 'pret', erreur = NULL, gcode_chemin = ?, poids_g = ?, duree_s = ?, nb_couches = ?,
      prix_matiere_cts = ?, livraison_cts = ?, decoupe_le = ? WHERE id = ?`),
    erreur: db.prepare("UPDATE devis SET statut = 'erreur', erreur = ?, decoupe_le = ? WHERE id = ?"),
  };

  // découpe interrompue par un redémarrage du serveur : on la reprend
  db.prepare("UPDATE devis SET statut = 'attente' WHERE statut = 'decoupe'").run();

  // ----- estimation de la durée (barre de progression du client) -----
  // Orca ne donne pas d'avancement en ligne de commande : la durée est estimée d'après le nombre de triangles,
  // à la vitesse mesurée sur les dernières découpes (par défaut : 28 pièces, ~400 000 triangles -> 458 s sur Fly).
  const BASE_S = 15;
  const PAR_TRIANGLE_DEFAUT_S = 1.1e-3;
  function vitesse() {
    let duree = 0, triangles = 0;
    for (const h of q.historique.all()) {
      if (h.duree > 0 && h.triangles > 0) { duree += Math.max(0, h.duree - BASE_S); triangles += h.triangles; }
    }
    return triangles >= 50000 ? duree / triangles : PAR_TRIANGLE_DEFAUT_S;
  }
  const estimer = (id, v = vitesse()) => Math.round(BASE_S + q.triangles.get(id).n * v);

  // { depuis_s, estimee_s } pendant la découpe ; { avant, attente_s, estimee_s } dans la file ; null sinon
  function progression(d, maintenant = Date.now()) {
    if (!['attente', 'decoupe'].includes(d.statut)) return null;
    const v = vitesse();
    if (d.statut === 'decoupe') {
      return { depuis_s: Math.max(0, Math.round((maintenant - (d.decoupe_debut_le || maintenant)) / 1000)), estimee_s: estimer(d.id, v) };
    }
    const devant = q.devant.all(d.id);
    const attente = devant.reduce((s, x) => s + (x.statut === 'decoupe'
      ? Math.max(0, estimer(x.id, v) - (maintenant - (x.decoupe_debut_le || maintenant)) / 1000) : estimer(x.id, v)), 0);
    return { avant: devant.length, attente_s: Math.round(attente), estimee_s: estimer(d.id, v) };
  }

  let occupe = false;
  let arrete = false;
  let enfant = null;

  class ErreurDecoupe extends Error {}   // message montré au client

  // Orca est lancé par xvfb-run : on tue tout le groupe de processus, sinon Orca survivrait à son lanceur
  // et garderait sa mémoire (Linux ; sous Windows, pour les essais locaux, le processus seul)
  const groupe = process.platform !== 'win32';
  function tuer() {
    if (!enfant) return;
    try {
      if (groupe) process.kill(-enfant.pid, 'SIGKILL'); else enfant.kill('SIGKILL');
    } catch { /* déjà fini */ }
  }

  function lancerOrca(args, dossier) {
    return new Promise((ok, ko) => {
      const env = { ...process.env, HOME: dossier, XDG_CONFIG_HOME: path.join(dossier, 'config'), LC_ALL: 'C.UTF-8' };
      enfant = spawn(commande[0], [...commande.slice(1), ...args], { cwd: dossier, env, stdio: ['ignore', 'pipe', 'pipe'], detached: groupe });
      let sortie = '';
      let tropLong = false;
      const garder = (d) => { sortie = (sortie + d).slice(-4000); };
      enfant.stdout.on('data', garder);
      enfant.stderr.on('data', garder);
      const minuteur = setTimeout(() => { tropLong = true; tuer(); }, O.delaiMs);
      enfant.on('error', (e) => { clearTimeout(minuteur); enfant = null; ko(e); });
      enfant.on('close', (code, signal) => { clearTimeout(minuteur); enfant = null; ok({ code, signal, sortie, tropLong }); });
    });
  }

  async function decouper(devis) {
    const imp = q.imprimante.get(devis.imprimante_id);
    const profils = path.join(O.profils, imp?.profil_orca || '');
    if (!imp || !fs.existsSync(path.join(profils, 'machine.json'))) throw new Error(`profils Orca absents : ${profils}`);

    const dossier = path.join(dossierTravail, `devis-${devis.id}`);
    await fsp.rm(dossier, { recursive: true, force: true });
    await fsp.mkdir(path.join(dossier, 'sortie'), { recursive: true });
    try {
      // STL (stockés compressés) -> fichiers temporaires ; une copie par exemplaire demandé
      const stls = [];
      for (const [i, p] of q.pieces.all(devis.id).entries()) {
        if (!p.chemin) throw new ErreurDecoupe(`Le fichier ${p.nom_origine} n'est plus disponible : dépose-le à nouveau.`);
        const f = path.join(dossier, `piece-${i + 1}.stl`);
        await pipeline(fs.createReadStream(path.join(config.donnees, p.chemin)), zlib.createGunzip(), fs.createWriteStream(f));
        for (let k = 0; k < p.quantite; k++) stls.push(f);
      }

      // profils du devis : seuls ces réglages, bornés à la création du devis, changent
      const lire = (nom) => JSON.parse(fs.readFileSync(path.join(profils, `${nom}.json`), 'utf8'));
      const machine = { ...lire('machine'), thumbnails: '' };         // pas de vignette : pas besoin d'OpenGL
      const couche = COUCHES[devis.proprete_mm] || COUCHES[0.2];
      const process_ = { ...lire('process'), ...couche,
        sparse_infill_density: `${devis.remplissage_pct}%`,
        top_shell_layers: String(devis.couches_surface), bottom_shell_layers: String(devis.couches_surface),
        top_shell_thickness: '0', bottom_shell_thickness: '0' };
      const ecrire = (nom, d) => { const f = path.join(dossier, `${nom}.json`); fs.writeFileSync(f, JSON.stringify(d)); return f; };
      const fm = ecrire('machine', machine), fp = ecrire('process', process_), ff = ecrire('filament', lire('filament'));

      const sortie = path.join(dossier, 'sortie');
      const r = await lancerOrca(['--arrange', '1', '--orient', '0', '--slice', '0',
        '--load-settings', `${fm};${fp}`, '--load-filaments', ff, '--outputdir', sortie, ...stls], dossier);
      const gcodes = (await fsp.readdir(sortie)).filter((n) => n.toLowerCase().endsWith('.gcode'));
      if (r.tropLong) throw new ErreurDecoupe('La découpe a pris trop de temps. Essaie avec moins de pièces.');
      // tué par le système (code 137 = signal 9) : plus de mémoire, même avec la mémoire d'échange
      if (r.code === 137 || r.signal === 'SIGKILL') {
        throw new ErreurDecoupe('Ce plateau est trop chargé pour être découpé en une fois : réessaie dans quelques minutes, '
          + 'ou répartis tes pièces sur plusieurs devis.');
      }
      if (gcodes.length > 1) throw new ErreurDecoupe('Tes pièces ne tiennent pas toutes sur un seul plateau : réduis les quantités ou fais plusieurs devis.');
      if (r.code !== 0 || !gcodes.length) {
        throw new Error(`Orca a échoué (code ${r.code}${r.signal ? `, ${r.signal}` : ''}) : ${r.sortie.trim().split('\n').slice(-8).join(' | ')}`);
      }

      // aperçu + chiffres, puis gcode compressé
      const gcode = path.join(sortie, gcodes[0]);
      const { meta, bin, stats } = await lireGcode(gcode);
      if (!stats.poids_g || !meta.segments) throw new Error('gcode sans extrusion ou sans poids');
      const cibles = fichiersDevis(dossierGcode, devis.id);
      await pipeline(fs.createReadStream(gcode), zlib.createGzip({ level: 6 }), fs.createWriteStream(cibles.gcode));
      fs.writeFileSync(cibles.bin, zlib.gzipSync(bin));
      fs.writeFileSync(cibles.meta, JSON.stringify(meta));
      const prix = calculerPrix(stats.poids_g);
      q.pret.run(path.relative(config.donnees, cibles.gcode), stats.poids_g, stats.duree_s, stats.nb_couches,
        prix.prix_matiere_cts, prix.livraison_cts, Date.now(), devis.id);
    } finally {
      await fsp.rm(dossier, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function tour() {
    if (occupe || arrete || !commande.length) return;
    occupe = true;
    try {
      let devis;
      while (!arrete && (devis = q.suivant.get())) {
        if (!q.prendre.run(Date.now(), devis.id).changes) continue;
        const debut = Date.now();
        try {
          await decouper(devis);
          console.log(`[orca] devis ${devis.id} découpé en ${Math.round((Date.now() - debut) / 1000)} s`);
        } catch (e) {
          if (arrete) {
            // serveur en train de s'arrêter (mise à jour, redémarrage) : Orca a été arrêté par nous, ce n'est pas
            // une erreur du devis ; il reprend au prochain démarrage
            db.prepare("UPDATE devis SET statut = 'attente' WHERE id = ? AND statut = 'decoupe'").run(devis.id);
            console.log(`[orca] devis ${devis.id} : découpe interrompue par l'arrêt du serveur, reprise au redémarrage`);
            continue;
          }
          console.error(`[orca] devis ${devis.id} : ${e.message}`);
          q.erreur.run(e instanceof ErreurDecoupe ? e.message : 'La découpe a échoué. Nous avons été prévenus ; réessaie plus tard.',
            Date.now(), devis.id);
        }
      }
    } finally {
      occupe = false;
    }
  }

  const minuteur = setInterval(() => tour(), O.intervalleMs).unref();
  setImmediate(() => tour());

  return {
    actif: commande.length > 0,
    reveiller: () => setImmediate(() => tour()),
    progression,
    fichiers: (id) => fichiersDevis(dossierGcode, id),
    // supprime gcode et aperçu d'un devis (devis supprimé, ou commande finie depuis longtemps)
    effacer(id) {
      for (const f of Object.values(fichiersDevis(dossierGcode, id))) fs.rmSync(f, { force: true });
    },
    async arreter() {
      arrete = true;
      clearInterval(minuteur);
      tuer();
      while (occupe) await new Promise((r) => setTimeout(r, 20));
    },
  };
}

module.exports = { creerDecoupeur, COUCHES };
