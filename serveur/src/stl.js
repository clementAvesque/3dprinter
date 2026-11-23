'use strict';
// Lecture d'un fichier STL (binaire ou texte) : nombre de triangles, dimensions, volume.
// Sert à refuser ce qui n'est pas un STL, à vérifier que la pièce rentre sur un plateau, et à mettre une pièce
// à l'échelle avant la découpe (STL exporté en mètres par Blender, par ex. : multiplicateur choisi par le client).

const TRIANGLES_MAX = 3_000_000;

class StlInvalide extends Error {}

// { n, sommet(i, k) -> [x, y, z] } pour un STL binaire ou texte
function lire(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 84) throw new StlInvalide('fichier trop petit pour être un STL');
  // binaire : en-tête de 80 octets, nombre de triangles, puis 50 octets par triangle.
  // (certains STL binaires commencent aussi par "solid" : la taille exacte départage)
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 === buf.length) {
    if (n === 0) throw new StlInvalide('aucun triangle');
    if (n > TRIANGLES_MAX) throw new StlInvalide(`trop de triangles (${n}, maximum ${TRIANGLES_MAX})`);
    return { n, sommet: (i, k) => {
      const o = 84 + i * 50 + 12 + k * 12;
      return [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)];
    } };
  }
  const debut = buf.subarray(0, 512).toString('latin1').trimStart();
  if (!debut.toLowerCase().startsWith('solid')) throw new StlInvalide('ni STL binaire, ni STL texte');
  const texte = buf.toString('latin1');
  const sommets = [];
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  for (let m; (m = re.exec(texte));) {
    sommets.push([Number(m[1]), Number(m[2]), Number(m[3])]);
    if (sommets.length > TRIANGLES_MAX * 3) throw new StlInvalide('trop de triangles');
  }
  if (!sommets.length || sommets.length % 3) throw new StlInvalide('STL texte incomplet');
  return { n: sommets.length / 3, sommet: (i, k) => sommets[i * 3 + k] };
}

function analyserStl(buf) {
  const { n, sommet } = lire(buf);
  return mesurer(n, sommet);
}

function mesurer(n, sommet) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let volume = 0;
  for (let i = 0; i < n; i++) {
    const a = sommet(i, 0), b = sommet(i, 1), c = sommet(i, 2);
    for (const p of [a, b, c]) {
      for (let d = 0; d < 3; d++) {
        if (!Number.isFinite(p[d])) throw new StlInvalide('coordonnée invalide');
        if (p[d] < min[d]) min[d] = p[d];
        if (p[d] > max[d]) max[d] = p[d];
      }
    }
    // volume signé du tétraèdre (origine, a, b, c) : la somme donne le volume d'une pièce fermée
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (dims.some((d) => d > 10000)) throw new StlInvalide('pièce de plus de 10 m : unité incorrecte ?');
  // très petit (0,05 = 5 cm exportés en mètres) : accepté, le client règle le multiplicateur de taille
  if (dims.every((d) => d < 1e-4)) throw new StlInvalide('pièce vide');
  return { triangles: n, dims, volume: Math.abs(volume) };
}

// STL (binaire ou texte) -> STL binaire dont toutes les coordonnées sont multipliées par k
function echelonnerStl(buf, k) {
  const { n, sommet } = lire(buf);
  const sortie = Buffer.alloc(84 + n * 50);
  sortie.write(`mis a l'echelle x${k}`.slice(0, 80), 0, 'latin1');
  sortie.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50;                      // normale laissée à 0 : recalculée par le slicer
    for (let s = 0; s < 3; s++) {
      const p = sommet(i, s);
      for (let d = 0; d < 3; d++) sortie.writeFloatLE(p[d] * k, o + 12 + s * 12 + d * 4);
    }
  }
  return sortie;
}

// Marge gardée de chaque côté du plateau (x, y) : bordure (brim 5 mm), bordure des supports arbre et écart avec
// le bord qu'Orca garde en rangeant. Sans elle, une pièce de 238 mm « tenait » sur 250 mm mais Orca la refusait
// (« No object is fully inside the print volume »). Même valeur dans le site client (lib/rangement.js).
const MARGE_PLATEAU_MM = 10;

// la pièce tient-elle sur le plateau, marges comprises ? (rotation de 90° autorisée sur le plateau)
function tientSur(dims, imp) {
  const [x, y, z] = dims;
  if (z > imp.plateau_z_mm) return false;
  const lx = imp.plateau_x_mm - 2 * MARGE_PLATEAU_MM, ly = imp.plateau_y_mm - 2 * MARGE_PLATEAU_MM;
  return (x <= lx && y <= ly) || (y <= lx && x <= ly);
}

module.exports = { analyserStl, echelonnerStl, tientSur, StlInvalide, MARGE_PLATEAU_MM };
