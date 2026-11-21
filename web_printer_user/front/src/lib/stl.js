// Lecture d'un STL dans le navigateur (rien n'est envoyé tant que le client n'a pas cliqué sur « Découper »).
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const chargeur = new STLLoader();

// géométrie posée sur le plateau : base à z = 0, centrée en x et y
export async function lireStl(fichier) {
  const octets = await fichier.arrayBuffer();
  let geo;
  try {
    geo = chargeur.parse(octets);
  } catch {
    throw new Error(`${fichier.name} n'est pas un STL lisible`);
  }
  const pos = geo.getAttribute('position');
  if (!pos || pos.count < 3) throw new Error(`${fichier.name} ne contient aucun triangle`);
  geo.computeBoundingBox();
  const b = geo.boundingBox;
  geo.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -b.min.z);
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  const t = geo.boundingBox.max.clone().sub(geo.boundingBox.min);
  if ([t.x, t.y, t.z].some((d) => !Number.isFinite(d)) || Math.max(t.x, t.y, t.z) > 10000) {
    throw new Error(`${fichier.name} : dimensions incohérentes (unité en mètres ?)`);
  }
  return { geometrie: geo, dims: [t.x, t.y, t.z], volume: volume(pos) };
}

function volume(pos) {
  let v = 0;
  for (let i = 0; i + 2 < pos.count; i += 3) {
    const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
    const bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
    const cx = pos.getX(i + 2), cy = pos.getY(i + 2), cz = pos.getZ(i + 2);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return Math.abs(v);
}
