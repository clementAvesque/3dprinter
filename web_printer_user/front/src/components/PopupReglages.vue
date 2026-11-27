<script setup>
// Réglage du remplissage (une fenêtre). Le reste (couches, parois, faces) est fixé par le profil de précision
// du serveur (ISO 2768-m) ; les valeurs possibles sont les seules acceptées par le serveur.
import { reactive, watch } from 'vue';

const props = defineProps({ ouvert: Boolean, reglages: { type: Object, required: true } });
const emit = defineEmits(['fermer', 'valider']);
const r = reactive({ ...props.reglages });
watch(() => props.ouvert, (o) => o && Object.assign(r, props.reglages));

const solidite = (p) => (p < 15 ? 'légère' : p < 35 ? 'standard' : p < 70 ? 'solide' : 'très solide');
</script>

<template>
  <Teleport to="body">
    <div v-if="ouvert" class="voile" @click.self="emit('fermer')">
      <div class="fenetre" role="dialog" aria-modal="true" aria-labelledby="titre-reglages">
        <header>
          <h2 id="titre-reglages">Réglages d'impression</h2>
          <button class="icone" aria-label="Fermer" @click="emit('fermer')">✕</button>
        </header>

        <section>
          <h3>Solidité</h3>
          <label class="curseur">
            <span>Remplissage <b>{{ r.remplissage_pct }} %</b> <em>{{ solidite(r.remplissage_pct) }}</em></span>
            <input v-model.number="r.remplissage_pct" type="range" min="5" max="100" step="5">
            <small>L'intérieur de la pièce. Plus il est rempli, plus elle est solide et lourde (donc plus chère).</small>
          </label>
        </section>

        <section>
          <h3>Qualité</h3>
          <p class="qualite">Toutes les pièces sont imprimées avec notre profil de précision, pour des cotes
            dans les tolérances générales ISO 2768-m (±0,1 mm jusqu'à 6 mm, ±0,2 mm jusqu'à 30 mm, ±0,3 mm
            jusqu'à 120 mm) : couches de 0,2 mm, 3 parois, 5 couches pleines dessus et 4 dessous.</p>
        </section>

        <footer>
          <button class="secondaire" @click="emit('fermer')">Annuler</button>
          <button class="primaire" @click="emit('valider', { remplissage_pct: r.remplissage_pct })">Appliquer</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
section { display: flex; flex-direction: column; gap: 14px; }
h3 { margin: 0; font-size: 14px; text-transform: uppercase; letter-spacing: .04em; color: var(--discret); }
.curseur { display: flex; flex-direction: column; gap: 6px; }
.curseur span { display: flex; gap: 8px; align-items: baseline; }
.curseur em { color: var(--discret); font-style: normal; font-size: 13px; }
.curseur input { width: 100%; accent-color: var(--accent); }
.curseur small { color: var(--discret); }
.qualite { margin: 0; color: var(--discret); font-size: 13px; line-height: 1.5; }
</style>
