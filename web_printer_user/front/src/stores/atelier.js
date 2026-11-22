import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import { api } from '../api.js';
import { lireStl } from '../lib/stl.js';
import { ranger, choisirImprimante, tient } from '../lib/rangement.js';

let suivant = 1;

export const ECHELLE_MIN = 0.001;
export const ECHELLE_MAX = 1000;

// pièces déposées (gardées dans le navigateur jusqu'à la découpe), réglages, imprimante choisie
export const useAtelier = defineStore('atelier', {
  state: () => ({
    // { id, nom, fichier, geometrie, dimsBase (mm du fichier), echelle, dims (= dimsBase x echelle), volume, quantite, auto }
    pieces: [],
    selection: null,       // id de la pièce sélectionnée (clic dans la liste ou sur le plateau 3D)
    reglages: { remplissage_pct: 15, couches_surface: 3, proprete: 'fine' },
    imprimantes: [],
    erreurs: [],
  }),
  getters: {
    imprimante(s) {
      return choisirImprimante(s.imprimantes, s.pieces);
    },
    trop_grandes(s) {
      return s.pieces.filter((p) => !s.imprimantes.some((i) => i.disponible && tient(p.dims, i.plateau_mm)));
    },
    trop_petites: (s) => s.pieces.filter((p) => Math.max(...p.dims) < 1),
    rangement() {
      return this.imprimante ? ranger(this.pieces, this.imprimante.plateau_mm) : { places: [], hors: [] };
    },
    nbPieces: (s) => s.pieces.reduce((t, p) => t + p.quantite, 0),
  },
  actions: {
    async chargerImprimantes() {
      if (!this.imprimantes.length) this.imprimantes = await api('GET', '/imprimantes');
    },
    async ajouter(fichiers) {
      this.erreurs = [];
      for (const f of fichiers) {
        if (!/\.stl$/i.test(f.name)) { this.erreurs.push(`${f.name} : seuls les fichiers .stl sont acceptés`); continue; }
        if (f.size > 100 * 1024 * 1024) { this.erreurs.push(`${f.name} : 100 Mo maximum`); continue; }
        try {
          const { geometrie, dims, volume } = await lireStl(f);
          // moins d'1 mm : presque toujours un fichier en mètres (export Blender) -> x1000, signalé au client
          const auto = Math.max(...dims) < 1;
          const echelle = auto ? 1000 : 1;
          this.pieces.push({ id: suivant++, nom: f.name, fichier: markRaw(f), geometrie: markRaw(geometrie), dimsBase: dims,
            echelle, dims: dims.map((v) => v * echelle), volume, quantite: 1, auto });
        } catch (e) {
          this.erreurs.push(e.message);
        }
      }
    },
    changerEchelle(id, valeur) {
      const p = this.pieces.find((x) => x.id === id);
      const e = Number(valeur);
      if (!p || !Number.isFinite(e) || e < ECHELLE_MIN || e > ECHELLE_MAX) return false;
      p.echelle = e;
      p.dims = p.dimsBase.map((v) => v * e);
      p.auto = false;
      return true;
    },
    choisir(id) {
      this.selection = this.selection === id ? null : id;
    },
    retirer(id) {
      const i = this.pieces.findIndex((p) => p.id === id);
      if (i >= 0) { this.pieces[i].geometrie.dispose(); this.pieces.splice(i, 1); }
      if (this.selection === id) this.selection = null;
    },
    vider() {
      for (const p of this.pieces) p.geometrie.dispose();
      this.pieces = [];
      this.selection = null;
    },
  },
});
