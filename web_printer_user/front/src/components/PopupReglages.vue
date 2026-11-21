<script setup>
// Réglages de solidité et de propreté (une fenêtre). Les valeurs possibles sont les seules acceptées par le serveur.
import { reactive, watch } from 'vue';

const props = defineProps({ ouvert: Boolean, reglages: { type: Object, required: true } });
const emit = defineEmits(['fermer', 'valider']);
const r = reactive({ ...props.reglages });
watch(() => props.ouvert, (o) => o && Object.assign(r, props.reglages));

const PROPRETES = [
  { id: 'fine', titre: 'Fine', detail: 'Couches de 0,2 mm et face visible lissée. Plus belle, plus longue.' },
  { id: 'rapide', titre: 'Rapide', detail: 'Couches de 0,28 mm, sans lissage. Plus rapide, stries visibles.' },
];
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
          <label class="curseur">
            <span>Couches de surface <b>{{ r.couches_surface }}</b></span>
            <input v-model.number="r.couches_surface" type="range" min="2" max="10" step="1">
            <small>Épaisseur des faces du dessus et du dessous.</small>
          </label>
        </section>

        <section>
          <h3>Propreté</h3>
          <div class="choix">
            <button v-for="p in PROPRETES" :key="p.id" type="button" class="carte-choix"
                    :class="{ actif: r.proprete === p.id }" :aria-pressed="r.proprete === p.id" @click="r.proprete = p.id">
              <b>{{ p.titre }}</b>
              <span>{{ p.detail }}</span>
            </button>
          </div>
        </section>

        <footer>
          <button class="secondaire" @click="emit('fermer')">Annuler</button>
          <button class="primaire" @click="emit('valider', { ...r })">Appliquer</button>
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
.choix { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.carte-choix { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 14px; border-radius: 12px;
  border: 1.5px solid var(--bord); background: var(--fond-champ); color: var(--texte); cursor: pointer; }
.carte-choix span { color: var(--discret); font-size: 13px; line-height: 1.4; }
.carte-choix.actif { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
@media (max-width: 520px) { .choix { grid-template-columns: 1fr; } }
</style>
