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

// STL binaire fait de pavés [x0, y0, z0, x1, y1, z1] (faces vers l'extérieur)
function stl(paves) {
  const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + paves.length * faces.length * 50);
  buf.writeUInt32LE(paves.length * faces.length, 80);
  let n = 0;
  for (const [x0, y0, z0, x1, y1, z1] of paves) {
    const s = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    for (const f of faces) {
      f.forEach((v, k) => s[v].forEach((x, d) => buf.writeFloatLE(x, 84 + n * 50 + 12 + k * 12 + d * 4)));
      n++;
    }
  }
  return buf;
}
const cube = (c = 20) => stl([[0, 0, 0, c, c, c]]);
// champignon : pied de 6 mm, chapeau de 30 mm à plat au-dessus du vide. Orientation automatique d'Orca
// (--orient 1) : il le retourne, chapeau sur le plateau -> plus aucun support nécessaire
const champignon = () => stl([[12, 12, 0, 18, 18, 15], [0, 0, 15, 30, 30, 18]]);
// croix en 3D (bras dans les 3 directions) : quelle que soit la face posée, deux bras horizontaux surplombent
// le vide -> doit recevoir des supports
const croix = () => stl([[12, 12, 0, 18, 18, 30], [0, 12, 12, 30, 18, 18], [12, 0, 12, 18, 30, 18]]);

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
  fs.writeFileSync(path.join(dossier, 'stl', 'champignon.stl.gz'), zlib.gzipSync(champignon()));
  const fichierChampignon = db.prepare(`INSERT INTO fichiers_stl (client_id, nom_origine, chemin, taille_octets, sha256, triangles,
    dim_x_mm, dim_y_mm, dim_z_mm, volume_mm3, cree_le, expire_le) VALUES (?, 'champignon.stl', 'stl/champignon.stl.gz', 1284, 'x', 24,
    30, 30, 18, 3240, ?, ?)`).run(client, now, now + 864e5).lastInsertRowid;
  fs.writeFileSync(path.join(dossier, 'stl', 'croix.stl.gz'), zlib.gzipSync(croix()));
  const fichierCroix = db.prepare(`INSERT INTO fichiers_stl (client_id, nom_origine, chemin, taille_octets, sha256, triangles,
    dim_x_mm, dim_y_mm, dim_z_mm, volume_mm3, cree_le, expire_le) VALUES (?, 'croix.stl', 'stl/croix.stl.gz', 1884, 'x', 36,
    30, 30, 30, 2808, ?, ?)`).run(client, now, now + 864e5).lastInsertRowid;
  // seul le remplissage change d'un devis à l'autre (profil ISO 2768-m pour le reste)
  const essais = [['remplissage 15 %', 15], ['remplissage 40 %', 40]];
  const ids = essais.map(([, remplissage]) => {
    const id = db.prepare(`INSERT INTO devis (client_id, imprimante_id, remplissage_pct, couches_surface, proprete_mm, statut, cree_le)
      VALUES (?, 'kobra-1', ?, 5, 0.2, 'attente', ?)`).run(client, remplissage, now).lastInsertRowid;
    db.prepare('INSERT INTO devis_pieces (devis_id, fichier_id, quantite) VALUES (?, ?, 2)').run(id, fichier);
    return id;
  });
  const idChampignon = db.prepare(`INSERT INTO devis (client_id, imprimante_id, remplissage_pct, couches_surface, proprete_mm, statut, cree_le)
    VALUES (?, 'kobra-1', 15, 5, 0.2, 'attente', ?)`).run(client, now).lastInsertRowid;
  db.prepare('INSERT INTO devis_pieces (devis_id, fichier_id, quantite) VALUES (?, ?, 1)').run(idChampignon, fichierChampignon);
  const idCroix = db.prepare(`INSERT INTO devis (client_id, imprimante_id, remplissage_pct, couches_surface, proprete_mm, statut, cree_le)
    VALUES (?, 'kobra-1', 15, 5, 0.2, 'attente', ?)`).run(client, now).lastInsertRowid;
  db.prepare('INSERT INTO devis_pieces (devis_id, fichier_id, quantite) VALUES (?, ?, 1)').run(idCroix, fichierCroix);
  // le gcode contient-il des supports ? (Orca annonce chaque type de trajet : « ;TYPE:Support »)
  const gcode = (id) => zlib.gunzipSync(fs.readFileSync(decoupeur.fichiers(id).gcode)).toString('latin1');
  const supports = (id) => /^;TYPE:Support/m.test(gcode(id));
  // plateau PEI texturé de la Kobra 3 : PLA à 60 °C (sans « curr_bed_type », Orca chauffe un « Cool Plate » à 35 °C)
  const plateau = (id) => Number(/^M140 S(\d+)/m.exec(gcode(id))?.[1]);
  // vitesse de chaque extrusion, par couche, hors lissage (finition)
  const vitesses = (id) => {
    const couches = [];
    let f = 0, type = '';
    for (const l of gcode(id).split('\n')) {
      if (l.startsWith(';LAYER_CHANGE')) couches.push(new Set());
      else if (l.startsWith(';TYPE:')) type = l.slice(6).trim().toLowerCase();
      const m = /^G[0-3] /.test(l) ? l : null;
      if (!m) continue;
      const nf = /F([\d.]+)/.exec(m);
      if (nf) f = Number(nf[1]);
      const e = /E([\d.-]+)/.exec(m);
      if (e && Number(e[1]) > 0 && /[XY]/.test(m) && type !== 'ironing' && couches.length) couches.at(-1).add(Math.round(f / 60));
    }
    return couches;
  };
  // buse : 215 °C pour la 1re couche (G9111 de la Kobra 3 au démarrage), puis 210 (M104/M109), 0 à la fin
  const buses = (id) => {
    const g = gcode(id);
    return [...g.matchAll(/^G9111 .*extruderTemp=(\d+)/gm), ...g.matchAll(/^M10[49] S(\d+)/gm)].map((m) => Number(m[1])).filter((t) => t !== 0);
  };

  const debut = Date.now();
  const decoupeur = creerDecoupeur({ config, db, calculerPrix: (p) => ({ prix_matiere_cts: Math.round(p * 20), livraison_cts: 500 }) });
  const statut = (id) => db.prepare('SELECT * FROM devis WHERE id = ?').get(id);
  while ([...ids, idChampignon, idCroix].some((id) => ['attente', 'decoupe'].includes(statut(id).statut))) {
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
    const b = buses(id);
    if (b[0] !== 215 || !b.includes(210) || b.some((t) => t !== 215 && t !== 210)) {
      ok = false;
      console.error(`[essai-orca]   ÉCHEC : buse à ${b.join(', ')} °C au lieu de 215 puis 210 °C`);
    } else console.log(`[essai-orca]   plateau ${plateau(id)} °C, buse ${b[0]} puis 210 °C`);
    // vitesses du profil ISO 2768-m : 1re couche 100 mm/s au plus, le reste 280 au plus
    const v = vitesses(id);
    const max1 = Math.max(...v[0]), max = Math.max(...v.flatMap((s) => [...s]));
    if (max1 > 100 || max > 280) {
      ok = false;
      console.error(`[essai-orca]   ÉCHEC : 1re couche jusqu'à ${max1} mm/s (100 max), reste jusqu'à ${max} mm/s (280 max)`);
    } else console.log(`[essai-orca]   vitesses : 1re couche jusqu'à ${max1} mm/s, ensuite jusqu'à ${max} mm/s`);
    // remplissage du devis et 3 parois du profil : relus dans les réglages écrits en fin de gcode
    const reglage = (nom) => new RegExp(`^; ${nom} = (.*)$`, 'm').exec(gcode(id))?.[1];
    if (reglage('sparse_infill_density') !== `${essais[i][1]}%` || reglage('wall_loops') !== '3' || Number(reglage('layer_height')) !== 0.2) {
      ok = false;
      console.error(`[essai-orca]   ÉCHEC : remplissage ${reglage('sparse_infill_density')}, ${reglage('wall_loops')} parois, `
        + `couches de ${reglage('layer_height')} mm (attendu ${essais[i][1]} %, 3, 0.2)`);
    }
    // ventilateur : coupé sur la 1re couche, 100 % ensuite
    if (!/^M106 S255/m.test(gcode(id))) { ok = false; console.error('[essai-orca]   ÉCHEC : ventilateur jamais à 100 %'); }
    if (plateau(id) !== 60) { ok = false; console.error(`[essai-orca]   ÉCHEC : plateau à ${plateau(id)} °C au lieu de 60 °C`); }
    if (supports(id)) { ok = false; console.error('[essai-orca]   ÉCHEC : supports ajoutés à un cube qui n\'en a pas besoin'); }
    // un objet par exemplaire, nommé d'après le STL (validation pièce par pièce des plaques, src/plaques.js)
    const objets = [...gcode(id).matchAll(/^EXCLUDE_OBJECT_DEFINE NAME=(piece-\d+\.stl)\S* CENTER=[-\d.]+,[-\d.]+ POLYGON=\[\[/gm)];
    if (objets.length !== 2 || objets.some((m) => m[1] !== 'piece-1.stl')) {
      ok = false;
      console.error(`[essai-orca]   ÉCHEC : ${objets.length} objet(s) définis dans le gcode au lieu de 2 (piece-1.stl)`);
    }
  }
  // orientation automatique : le champignon est retourné (chapeau sur le plateau), donc sans supports
  const c = statut(idChampignon);
  if (c.statut !== 'pret') { ok = false; console.error(`[essai-orca] champignon : ÉCHEC (${c.erreur})`); }
  else if (supports(idChampignon)) { ok = false; console.error('[essai-orca] champignon : ÉCHEC, supports ajoutés (pièce pas retournée par Orca ?)'); }
  else console.log(`[essai-orca] champignon : retourné par Orca, sans supports -> ${c.poids_g} g, ${c.duree_s} s d'impression`);
  // supports arbre : ajoutés là où la pièce surplombe le vide dans toutes les positions
  const x = statut(idCroix);
  if (x.statut !== 'pret') { ok = false; console.error(`[essai-orca] croix : ÉCHEC (${x.erreur})`); }
  else if (!supports(idCroix)) { ok = false; console.error('[essai-orca] croix : ÉCHEC, aucun support sous les bras'); }
  else console.log(`[essai-orca] croix (surplomb) : supports ajoutés -> ${x.poids_g} g, ${x.duree_s} s d'impression`);
  console.log(`[essai-orca] terminé en ${Math.round((Date.now() - debut) / 1000)} s`);
  db.close();
  fs.rmSync(dossier, { recursive: true, force: true });
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(`[essai-orca] ${e.message}`);
  process.exit(1);
});
