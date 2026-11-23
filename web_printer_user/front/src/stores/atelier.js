import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import { api, telechargerStlProjet } from '../api.js';
import { lireStl, lireOctets } from '../lib/stl.js';
import { ranger, choisirImprimante, tient, echelleMax } from '../lib/rangement.js';

let suivant = 1;

export const ECHELLE_MIN = 0.001;
export const ECHELLE_MAX = 1000;

// pièces déposées (gardées dans le navigateur jusqu'à la découpe), réglages, imprimante choisie
export const useAtelier = defineStore('atelier', {
  state: () => ({
    // { id, nom, fichier, geometrie, dimsBase (mm du fichier), echelle, dims (= dimsBase x echelle), volume, quantite, auto,
    //   projet } ; projet = { id, n, titre, auteur } pour une pièce ouverte depuis la galerie (fichier = null : elle reste
    //   sur le serveur, le devis la désigne par projet + numéro)
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
    // plus grand multiplicateur de taille possible pour une pièce (meilleure imprimante disponible, marges comprises)
    echelleMax: (s) => (p) => Math.max(0, ...s.imprimantes.filter((i) => i.disponible).map((i) => echelleMax(p.dimsBase, i.plateau_mm))),
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
    // projet de la galerie ouvert dans l'atelier : ses pièces (STL téléchargés), tailles et quantités d'origine.
    // Atelier vide : ses réglages aussi. Tout reste modifiable avant « Découper ».
    async ajouterProjet(projet) {
      this.erreurs = [];
      const vide = !this.pieces.length;
      const lues = [];
      try {
        for (const x of projet.pieces) {
          const nom = `${x.nom}.stl`;
          const { geometrie, dims, volume } = lireOctets(await telechargerStlProjet(projet.id, x.n), nom);
          lues.push({ id: suivant++, nom, fichier: null, geometrie: markRaw(geometrie), dimsBase: dims, echelle: x.echelle,
            dims: dims.map((v) => v * x.echelle), volume, quantite: x.quantite, auto: false,
            projet: { id: projet.id, n: x.n, titre: projet.titre, auteur: projet.auteur } });
        }
      } catch (e) {
        for (const p of lues) p.geometrie.dispose();
        throw e;
      }
      this.pieces.push(...lues);
      if (vide) this.reglages = { ...projet.reglages };
      this.selection = lues[0]?.id ?? null;
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
