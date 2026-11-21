'use strict';
// Essai de bout en bout de la découpe, avec le VRAI OrcaSlicer et les vrais profils (serveur/orca/) :
// crée une base jetable, un cube de 20 mm, un devis, puis laisse src/orca.js le découper.
//
//   node scripts/essai-orca.js            (ORCA_CMD doit indiquer la commande d'Orca)
//
// Lancé pendant la construction de l'image Docker : si Orca ne marche pas, l'image n'est pas construite
// et le serveur en ligne reste sur sa version précédente. Code de sortie 0 = découpe réussie.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'essai-orca-'));
process.env.DONNEES = dossier;
process.env.CONFIG = path.join(dossier, 'absent.json');
const { charger } = require('../src/config');
const { ouvrir } = require('../src/db');
const { creerDecoupeur } = require('../src/orca');

function cube(c = 20) {
  const s = [[0, 0, 0], [c, 0, 0], [c, c, 0], [0, c, 0], [0, 0, c], [c, 0, c], [c, c, c], [0, c, c]];
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + faces.length * 50);
  buf.writeUInt32LE(faces.length, 80);
  faces.forEach((f, i) => f.forEach((v, k) => s[v].forEach((x, d) => buf.writeFloatLE(x, 84 + i * 50 + 12 + k * 12 + d * 4))));
  return buf;
}

async function main() {
  const config = charger();
  if (!config.orca.commande) throw new Error('ORCA_CMD vide : rien à essayer');
  config.orca.intervalleMs = 200;
  const db = ouvrir(config.donnees);
  const now = Date.now();
  const client = db.prepare("INSERT INTO clients (email, hash, nom, cree_le) VALUES ('essai@local', 'x', 'Essai', ?)").run(now).lastInsertRowid;
  fs.mkdirSync(path.join(dossier, 'stl'), { recursive: true });
  fs.writeFileSync(path.join(dossier, 'stl', 'cube.stl.gz'), zlib.gzipSync(cube()));
  const fichier = db.prepare(`INSERT INTO fichiers_stl (client_id, nom_origine, chemin, taille_octets, sha256, triangles,
    dim_x_mm, dim_y_mm, dim_z_mm, volume_mm3, cree_le, expire_le) VALUES (?, 'cube.stl', 'stl/cube.stl.gz', 684, 'x', 12, 20, 20, 20, 8000, ?, ?)`)
    .run(client, now, now + 864e5).lastInsertRowid;
  const essais = [['fine', 0.2], ['rapide', 0.4]];
  const ids = essais.map(([, couche]) => {
    const id = db.prepare(`INSERT INTO devis (client_id, imprimante_id, remplissage_pct, couches_surface, proprete_mm, statut, cree_le)
      VALUES (?, 'kobra-1', 15, 3, ?, 'attente', ?)`).run(client, couche, now).lastInsertRowid;
    db.prepare('INSERT INTO devis_pieces (devis_id, fichier_id, quantite) VALUES (?, ?, 2)').run(id, fichier);
    return id;
  });

  const debut = Date.now();
  const decoupeur = creerDecoupeur({ config, db, calculerPrix: (p) => ({ prix_matiere_cts: Math.round(p * 20), livraison_cts: 500 }) });
  const statut = (id) => db.prepare('SELECT * FROM devis WHERE id = ?').get(id);
  while (ids.some((id) => ['attente', 'decoupe'].includes(statut(id).statut))) {
    if (Date.now() - debut > config.orca.delaiMs + 60e3) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 500));
  }
  await decoupeur.arreter();
  let ok = true;
  for (const [i, id] of ids.entries()) {
    const d = statut(id);
    if (d.statut !== 'pret') { ok = false; console.error(`[essai-orca] ${essais[i][0]} : ÉCHEC (${d.erreur})`); continue; }
    console.log(`[essai-orca] ${essais[i][0]} : 2 cubes de 20 mm -> ${d.poids_g} g, ${d.nb_couches} couches, ${d.duree_s} s d'impression`);
    // les 2 cubes doivent être rangés côte à côte (pas l'un sur l'autre) et sur le plateau
    const [x0, y0, , x1, y1, z1] = JSON.parse(fs.readFileSync(decoupeur.fichiers(id).meta, 'utf8')).bbox;
    console.log(`[essai-orca]   emprise : x ${x0} à ${x1}, y ${y0} à ${y1}, hauteur ${z1} mm`);
    if (Math.max(x1 - x0, y1 - y0) < 39 || x0 < 0 || y0 < 0 || x1 > 255 || y1 > 255 || Math.abs(z1 - 20) > 0.5) {
      ok = false;
      console.error('[essai-orca]   ÉCHEC : pièces mal rangées (superposées ou hors du plateau)');
    }
  }
  console.log(`[essai-orca] terminé en ${Math.round((Date.now() - debut) / 1000)} s`);
  db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(`[essai-orca] ${e.message}`);
  process.exit(1);
});
