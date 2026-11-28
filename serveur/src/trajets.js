'use strict';
// Lecture d'un gcode en trajets 3D (aperçu couche par couche) + chiffres utiles (poids, durée).
// Même format que client_printer/toolpath.py, lu par les visualiseurs du site client et de l'admin :
//   meta : { version, segments, layers: [[z, debut, nombre], ...], types, bbox, min_len }
//   bin  : N x 4 int16 (x1, y1, x2, y2 en centièmes de mm), puis N x 1 uint8 (type de trajet)
// Seules les extrusions sont gardées ; les tout petits segments sont fusionnés (aperçu fluide).

const fs = require('node:fs');
const readline = require('node:readline');

const VERSION = 2;    // 2 : couches découpées sur ;LAYER_CHANGE (invalide le cache de métadonnées)

// Une couche commence au marqueur ;LAYER_CHANGE du slicer. Dès qu'un marqueur a été vu, le Z n'est PLUS
// un critère : certains gcode font monter Z en continu pendant l'extrusion (jusqu'à une hauteur de couche
// entière à l'intérieur d'une seule couche), ce qui ouvrait une couche par segment — 52988 au lieu de 163
// sur la plaque P0013. Aucun seuil ne sépare ces cas, seul le marqueur est fiable.
// Le seuil ci-dessous ne sert qu'aux gcode sans aucun marqueur (repli).
const SEUIL_COUCHE = 0.02;

const TYPES = ['Paroi externe', 'Paroi interne', 'Remplissage', 'Remplissage plein',
  'Surface dessus/dessous', 'Support', 'Jupe / bordure', 'Autre'];
const NOMS_TYPES = {
  0: ['outer wall', 'wall-outer', 'external perimeter', 'overhang wall', 'overhang perimeter'],
  1: ['inner wall', 'wall-inner', 'perimeter'],
  2: ['sparse infill', 'fill', 'internal infill'],
  3: ['internal solid infill', 'solid infill', 'gap infill', 'bridge', 'internal bridge', 'bridge infill'],
  4: ['top surface', 'bottom surface', 'top solid infill', 'skin', 'ironing'],
  5: ['support', 'support interface', 'support transition', 'support-interface', 'support material',
    'support material interface'],
  6: ['skirt', 'brim', 'skirt/brim', 'prime tower', 'wipe tower'],
};
const INDEX_TYPES = new Map(Object.entries(NOMS_TYPES).flatMap(([i, noms]) => noms.map((n) => [n, Number(i)])));
const AUTRE = TYPES.length - 1;
const typeDe = (nom) => INDEX_TYPES.get(nom.trim().toLowerCase()) ?? AUTRE;

function longueurMin(taille) {
  if (taille < 15e6) return 0.25;
  if (taille < 40e6) return 0.5;
  return 0.9;
}

// "1d 2h 3m 4s" -> secondes
function duree(texte) {
  let s = 0;
  for (const [, n, u] of texte.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) s += Number(n) * { d: 86400, h: 3600, m: 60, s: 1 }[u];
  return Math.round(s);
}

// arc G2 (horaire) / G3 découpé en segments d'environ `pas` mm
function arc(x0, y0, x1, y1, i, j, horaire, pas = 1) {
  const cx = x0 + i, cy = y0 + j, r = Math.hypot(i, j);
  const a0 = Math.atan2(y0 - cy, x0 - cx), a1 = Math.atan2(y1 - cy, x1 - cx);
  let d = a1 - a0;
  if (horaire) { if (d >= 0) d -= 2 * Math.PI; } else if (d <= 0) d += 2 * Math.PI;
  const n = Math.max(1, Math.min(64, Math.floor(Math.abs(d) * r / pas)));
  const pts = [];
  for (let k = 1; k < n; k++) pts.push([cx + r * Math.cos(a0 + d * k / n), cy + r * Math.sin(a0 + d * k / n)]);
  pts.push([x1, y1]);
  return pts;
}

// tableau d'entiers qui grandit (évite un tableau JS de millions de nombres)
class Tampon {
  constructor(Type) { this.Type = Type; this.t = new Type(1 << 16); this.n = 0; }
  pousser(...v) {
    if (this.n + v.length > this.t.length) { const t = new this.Type(this.t.length * 2); t.set(this.t); this.t = t; }
    for (const x of v) this.t[this.n++] = x;
  }
  octets() { return Buffer.from(this.t.buffer, this.t.byteOffset, this.n * this.t.BYTES_PER_ELEMENT); }
}

/**
 * Lit le gcode `chemin`. Retourne { meta, bin: Buffer, stats: { poids_g, duree_s, nb_couches } }.
 * Les chiffres viennent des commentaires du slicer (OrcaSlicer / Anycubic Slicer Next / PrusaSlicer).
 */
async function lireGcode(chemin) {
  const minLen = longueurMin(fs.statSync(chemin).size), minLen2 = minLen * minLen;
  const coords = new Tampon(Int16Array), types = new Tampon(Uint8Array);
  const couches = [];                     // [z, debut, nombre]
  const stats = { poids_g: null, duree_s: null, couches_annoncees: null, filament_mm: null, densite: null, diametre: null };

  let x = 0, y = 0, z = 0, e = 0, absXYZ = true, absE = false, t = AUTRE, zCouche = null, marqueurCouche = false, marqueurVu = false;
  let ax = null, ay = null, px = null, py = null;          // dernier point émis / point en attente
  let xmin = 1e9, ymin = 1e9, xmax = -1e9, ymax = -1e9;
  const c100 = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 100)));
  const emettre = (x1, y1, x2, y2) => { coords.pousser(c100(x1), c100(y1), c100(x2), c100(y2)); types.pousser(t); };

  const lignes = readline.createInterface({ input: fs.createReadStream(chemin, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (let ligne of lignes) {
    const c0 = ligne[0];
    if (c0 === ';') {
      if (ligne.startsWith(';TYPE:')) {
        const nouveau = typeDe(ligne.slice(6));
        if (nouveau !== t) {
          if (px !== null) { emettre(ax, ay, px, py); ax = px; ay = py; px = py = null; }
          t = nouveau;
        }
        continue;
      }
      if (ligne.startsWith(';LAYER_CHANGE') || ligne.startsWith(';LAYER:') || ligne.startsWith(';CHANGE_LAYER')) {
        marqueurCouche = marqueurVu = true;
        continue;
      }
      // commentaires du slicer : poids, durée, couches (on garde la première valeur trouvée)
      let m;
      if (stats.poids_g === null && (m = /^;\s*(?:total )?filament (?:used|weight) \[g\]\s*[:=]\s*([\d.]+)/.exec(ligne))) stats.poids_g = Number(m[1]);
      else if (stats.duree_s === null && (m = /^;\s*(?:estimated printing time \(normal mode\)|model printing time)\s*[:=]\s*(.+)$/.exec(ligne))) stats.duree_s = duree(m[1].split(';')[0]);
      else if (stats.couches_annoncees === null && (m = /^;\s*total (?:layer number|layers count)\s*[:=]\s*(\d+)/.exec(ligne))) stats.couches_annoncees = Number(m[1]);
      else if (stats.filament_mm === null && (m = /^;\s*(?:total )?filament used \[mm\]\s*[:=]\s*([\d.]+)/.exec(ligne))) stats.filament_mm = Number(m[1]);
      else if (stats.densite === null && (m = /^;\s*filament_density\s*=\s*([\d.]+)/.exec(ligne))) stats.densite = Number(m[1]);
      else if (stats.diametre === null && (m = /^;\s*filament_diameter\s*=\s*([\d.]+)/.exec(ligne))) stats.diametre = Number(m[1]);
      continue;
    }
    if (c0 !== 'G' && c0 !== 'M') continue;
    const i = ligne.indexOf(';');
    if (i >= 0) ligne = ligne.slice(0, i);
    const mots = ligne.trim().split(/\s+/);
    const cmd = mots[0];

    if (cmd === 'G1' || cmd === 'G0' || cmd === 'G2' || cmd === 'G3') {
      let nx = x, ny = y, nz = z, de = 0, ci = null, cj = null;
      for (let k = 1; k < mots.length; k++) {
        const l = mots[k][0], v = Number(mots[k].slice(1));
        if (!Number.isFinite(v)) continue;
        if (l === 'X') nx = absXYZ ? v : x + v;
        else if (l === 'Y') ny = absXYZ ? v : y + v;
        else if (l === 'Z') nz = absXYZ ? v : z + v;
        else if (l === 'E') { de = absE ? v - e : v; e = absE ? v : e + v; }
        else if (l === 'I') ci = v;
        else if (l === 'J') cj = v;
      }
      const bouge = nx !== x || ny !== y;
      if (de > 0 && bouge) {
        if (zCouche === null || marqueurCouche || (!marqueurVu && Math.abs(nz - zCouche) > SEUIL_COUCHE)) {
          if (px !== null) emettre(ax, ay, px, py);
          px = py = null;
          if (couches.length) couches[couches.length - 1][2] = types.n - couches[couches.length - 1][1];
          couches.push([Math.round(nz * 1000) / 1000, types.n, 0]);
          zCouche = nz;
          marqueurCouche = false;
          ax = ay = null;
        }
        const points = (cmd === 'G2' || cmd === 'G3') && ci !== null && cj !== null ? arc(x, y, nx, ny, ci, cj, cmd === 'G2') : [[nx, ny]];
        if (ax === null || (px === null && (ax !== x || ay !== y))) { ax = x; ay = y; }
        for (const [qx, qy] of points) {
          px = qx; py = qy;
          if ((px - ax) ** 2 + (py - ay) ** 2 >= minLen2) { emettre(ax, ay, px, py); ax = px; ay = py; px = py = null; }
          if (qx < xmin) xmin = qx; if (qx > xmax) xmax = qx;
          if (qy < ymin) ymin = qy; if (qy > ymax) ymax = qy;
        }
      } else if (bouge || nz !== z) {
        if (px !== null) emettre(ax, ay, px, py);
        ax = ay = px = py = null;
      }
      x = nx; y = ny; z = nz;
    } else if (cmd === 'G90') absXYZ = true;
    else if (cmd === 'G91') absXYZ = false;
    else if (cmd === 'M82') absE = true;
    else if (cmd === 'M83') absE = false;
    else if (cmd === 'G92') {
      for (const m of mots.slice(1)) {
        const v = Number(m.slice(1));
        if (!Number.isFinite(v)) continue;
        if (m[0] === 'E') e = v; else if (m[0] === 'X') x = v; else if (m[0] === 'Y') y = v; else if (m[0] === 'Z') z = v;
      }
    }
  }
  if (px !== null) emettre(ax, ay, px, py);
  if (couches.length) couches[couches.length - 1][2] = types.n - couches[couches.length - 1][1];
  const layers = couches.filter((c) => c[2] > 0);

  // poids absent des commentaires : longueur de filament x section x densité
  if (stats.poids_g === null && stats.filament_mm) {
    const r = (stats.diametre || 1.75) / 2;
    stats.poids_g = Math.round(stats.filament_mm * Math.PI * r * r * (stats.densite || 1.24) / 1000 * 100) / 100;
  }
  const meta = {
    version: VERSION, segments: types.n, layers, types: TYPES,
    bbox: layers.length ? [Math.round(xmin * 100) / 100, Math.round(ymin * 100) / 100, layers[0][0],
      Math.round(xmax * 100) / 100, Math.round(ymax * 100) / 100, layers[layers.length - 1][0]] : null,
    min_len: minLen,
  };
  return {
    meta,
    bin: Buffer.concat([coords.octets(), types.octets()]),
    stats: { poids_g: stats.poids_g, duree_s: stats.duree_s, nb_couches: stats.couches_annoncees ?? layers.length },
  };
}

module.exports = { lireGcode, duree, TYPES };
