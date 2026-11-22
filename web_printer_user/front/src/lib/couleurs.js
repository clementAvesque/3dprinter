// Couleur de chaque pièce de l'atelier : la même dans la liste et sur le plateau 3D (pour les reconnaître).
export const COULEURS_PIECES = ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#84cc16'];
export const couleurPiece = (index) => COULEURS_PIECES[index % COULEURS_PIECES.length];
