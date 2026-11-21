'use strict';
// Lecture d'un fichier STL (binaire ou texte) : nombre de triangles, dimensions, volume.
// Sert à refuser ce qui n'est pas un STL et à vérifier que la pièce rentre sur un plateau.

const TRIANGLES_MAX = 3_000_000;

class StlInvalide extends Error {}

function analyserStl(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 84) throw new StlInvalide('fichier trop petit pour être un STL');
  // binaire : en-tête de 80 octets, nombre de triangles, puis 50 octets par triangle.
  // (certains STL binaires commencent aussi par "solid" : la taille exacte départage)
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 === buf.length) {
    if (n === 0) throw new StlInvalide('aucun triangle');
    if (n > TRIANGLES_MAX) throw new StlInvalide(`trop de triangles (${n}, maximum ${TRIANGLES_MAX})`);
    return mesurer(n, (i, k) => {
      const o = 84 + i * 50 + 12 + k * 12;
      return [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)];
    });
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
  return mesurer(sommets.length / 3, (i, k) => sommets[i * 3 + k]);
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
  if (dims.every((d) => d < 0.1)) throw new StlInvalide('pièce vide ou minuscule');
  return { triangles: n, dims, volume: Math.abs(volume) };
}

// la pièce tient-elle sur le plateau ? (rotation de 90° autorisée sur le plateau)
function tientSur(dims, imp) {
  const [x, y, z] = dims;
  if (z > imp.plateau_z_mm) return false;
  return (x <= imp.plateau_x_mm && y <= imp.plateau_y_mm) || (y <= imp.plateau_x_mm && x <= imp.plateau_y_mm);
}

module.exports = { analyserStl, tientSur, StlInvalide };
