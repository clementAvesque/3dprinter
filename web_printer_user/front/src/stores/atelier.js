import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import { api } from '../api.js';
import { lireStl } from '../lib/stl.js';
import { ranger, choisirImprimante, tient } from '../lib/rangement.js';

let suivant = 1;

// pièces déposées (gardées dans le navigateur jusqu'à la découpe), réglages, imprimante choisie
export const useAtelier = defineStore('atelier', {
  state: () => ({
    pieces: [],            // { id, nom, fichier, geometrie, dims, volume, quantite }
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
        if (f.size > 50 * 1024 * 1024) { this.erreurs.push(`${f.name} : 50 Mo maximum`); continue; }
        try {
          const { geometrie, dims, volume } = await lireStl(f);
          this.pieces.push({ id: suivant++, nom: f.name, fichier: markRaw(f), geometrie: markRaw(geometrie), dims, volume, quantite: 1 });
        } catch (e) {
          this.erreurs.push(e.message);
        }
      }
    },
    retirer(id) {
      const i = this.pieces.findIndex((p) => p.id === id);
      if (i >= 0) { this.pieces[i].geometrie.dispose(); this.pieces.splice(i, 1); }
    },
    vider() {
      for (const p of this.pieces) p.geometrie.dispose();
      this.pieces = [];
    },
  },
});
