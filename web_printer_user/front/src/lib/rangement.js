// Rangement automatique des pièces sur un plateau (aperçu) : rangement « en étagères » des empreintes
// rectangulaires, les plus grandes d'abord, avec rotation de 90° si elle fait gagner de la place.
// Le rangement définitif est refait par Orca au moment de la découpe.

export const MARGE = 6;          // mm entre deux pièces et avec le bord

// marge gardée de chaque côté du plateau pour la découpe : bordure (brim) et supports ajoutés par Orca.
// Même valeur que MARGE_PLATEAU_MM côté serveur (serveur/src/stl.js).
export const MARGE_PLATEAU = 10;

// une pièce tient-elle sur ce plateau, marges comprises (rotation de 90° autorisée) ?
export function tient([x, y, z], [px, py, pz]) {
  const lx = px - 2 * MARGE_PLATEAU, ly = py - 2 * MARGE_PLATEAU;
  return z <= pz && ((x <= lx && y <= ly) || (y <= lx && x <= ly));
}

// plus grand multiplicateur de taille pour lequel une pièce (dimensions du fichier) tient sur ce plateau
export function echelleMax([x, y, z], [px, py, pz]) {
  const lx = px - 2 * MARGE_PLATEAU, ly = py - 2 * MARGE_PLATEAU;
  const m = Math.max(Math.min(lx / x, ly / y), Math.min(lx / y, ly / x));
  return Math.floor(Math.min(m, pz / z) * 100) / 100;
}

// pieces : [{ id, dims: [x, y, z], quantite }] ; plateau : [x, y, z]
// retourne { places: [{ id, n, x, y, rot }], hors: [{ id, n }] }  (x, y = centre de la pièce, en mm)
export function ranger(pieces, plateau) {
  const [L, H] = plateau;
  const items = [];
  for (const p of pieces) {
    for (let n = 0; n < p.quantite; n++) items.push({ id: p.id, n, l: p.dims[0], h: p.dims[1] });
  }
  // couchées : le plus long côté en largeur, puis les plus hautes d'abord
  for (const it of items) if (it.h > it.l && it.h <= L - 2 * MARGE) [it.l, it.h, it.rot] = [it.h, it.l, 90];
  items.sort((a, b) => b.h - a.h || b.l - a.l);

  const etageres = [];        // { y, h, x }
  const places = [], hors = [];
  let yLibre = MARGE;
  for (const it of items) {
    let e = etageres.find((s) => it.h <= s.h && s.x + it.l <= L - MARGE);
    if (!e && yLibre + it.h <= H - MARGE && MARGE + it.l <= L - MARGE) {
      e = { y: yLibre, h: it.h, x: MARGE };
      etageres.push(e);
      yLibre += it.h + MARGE;
    }
    if (!e) { hors.push({ id: it.id, n: it.n }); continue; }
    places.push({ id: it.id, n: it.n, x: e.x + it.l / 2, y: e.y + it.h / 2, rot: it.rot || 0, l: it.l, h: it.h });
    e.x += it.l + MARGE;
  }
  // le groupe de pièces est centré sur le plateau (comme le fera Orca), bien visible dans la vue 3D
  if (places.length) {
    const x0 = Math.min(...places.map((p) => p.x - p.l / 2)), x1 = Math.max(...places.map((p) => p.x + p.l / 2));
    const y0 = Math.min(...places.map((p) => p.y - p.h / 2)), y1 = Math.max(...places.map((p) => p.y + p.h / 2));
    const dx = (L - x1 - x0) / 2, dy = (H - y1 - y0) / 2;
    for (const p of places) { p.x += dx; p.y += dy; delete p.l; delete p.h; }
  }
  return { places, hors };
}

// imprimante la plus adaptée : la plus petite (surface du plateau) où toutes les pièces tiennent,
// en préférant celle où tout rentre sur un seul plateau
export function choisirImprimante(imprimantes, pieces) {
  const possibles = imprimantes.filter((i) => i.disponible && pieces.every((p) => tient(p.dims, i.plateau_mm)))
    .sort((a, b) => a.plateau_mm[0] * a.plateau_mm[1] - b.plateau_mm[0] * b.plateau_mm[1]);
  return possibles.find((i) => !ranger(pieces, i.plateau_mm).hors.length) || possibles[0] || null;
}
