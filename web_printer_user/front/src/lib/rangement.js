// Rangement automatique des pièces sur un plateau (aperçu) : rangement « en étagères » des empreintes
// rectangulaires, les plus grandes d'abord, avec rotation de 90° si elle fait gagner de la place.
// Le rangement définitif est refait par Orca au moment de la découpe.

export const MARGE = 6;          // mm entre deux pièces et avec le bord

// une pièce tient-elle sur ce plateau (rotation de 90° autorisée) ?
export function tient([x, y, z], [px, py, pz]) {
  return z <= pz && ((x <= px && y <= py) || (y <= px && x <= py));
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
    places.push({ id: it.id, n: it.n, x: e.x + it.l / 2, y: e.y + it.h / 2, rot: it.rot || 0 });
    e.x += it.l + MARGE;
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
