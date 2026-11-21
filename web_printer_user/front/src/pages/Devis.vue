<script setup>
// Devis : pièces envoyées, réglages, puis (quand le serveur a découpé avec OrcaSlicer) aperçu 3D couche par
// couche, poids, prix et commande.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import ApercuGcode from '../components/ApercuGcode.vue';

const route = useRoute();
const devis = ref(null), erreur = ref('');
let minuteur = null;

const STATUTS = {
  attente: ['En file pour la découpe', 'Tes pièces vont être découpées par OrcaSlicer pour calculer le poids exact et le prix.'],
  decoupe: ['Découpe en cours', 'OrcaSlicer prépare l\'impression : calcul du poids et du prix… (une minute ou deux)'],
  pret: ['Devis prêt', ''],
  erreur: ['Découpe impossible', ''],
};
const PROPRETES = { fine: 'Fine · 0,2 mm + lissage', rapide: 'Rapide · 0,28 mm' };
const euros = (cts) => (cts == null ? '—' : `${(cts / 100).toFixed(2).replace('.', ',')} €`);
const mm = (v) => `${Math.round(v * 10) / 10}`.replace('.', ',');
const statut = computed(() => STATUTS[devis.value?.statut] || ['', '']);
const duree = (s) => {
  if (s == null) return '—';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
};

async function charger() {
  try {
    devis.value = await api('GET', `/devis/${encodeURIComponent(route.params.id)}`);
    if (['attente', 'decoupe'].includes(devis.value.statut)) minuteur = setTimeout(charger, 4000);
  } catch (e) {
    erreur.value = e.message;
  }
}
onMounted(charger);
onBeforeUnmount(() => clearTimeout(minuteur));

// découpe en erreur : relançable tant que tous les fichiers sont encore là
const relancable = computed(() => devis.value?.statut === 'erreur' && devis.value.pieces.every((p) => p.fichier_disponible));
const relance = ref(false);
async function relancer() {
  relance.value = true;
  erreur.value = '';
  try {
    devis.value = await api('POST', `/devis/${encodeURIComponent(devis.value.id)}/relancer`, {});
    clearTimeout(minuteur);
    minuteur = setTimeout(charger, 4000);
  } catch (e) {
    erreur.value = e.message;
  } finally {
    relance.value = false;
  }
}
</script>

<template>
  <main class="page-texte">
    <p v-if="erreur" class="erreur">{{ erreur }}</p>
    <template v-if="devis">
      <h1>Devis n° {{ devis.id }}</h1>
      <div class="carte statut" :class="devis.statut">
        <b>{{ statut[0] }}</b>
        <span v-if="statut[1]">{{ statut[1] }}</span>
        <span v-if="devis.erreur" class="erreur">{{ devis.erreur }}</span>
        <button v-if="relancable" class="primaire relancer" :disabled="relance" @click="relancer">Relancer la découpe</button>
      </div>

      <div class="carte">
        <h2>Pièces</h2>
        <ul class="liste">
          <li v-for="p in devis.pieces" :key="p.id">
            <span>{{ p.nom }}</span>
            <small class="discret">{{ mm(p.dims_mm[0]) }} × {{ mm(p.dims_mm[1]) }} × {{ mm(p.dims_mm[2]) }} mm</small>
            <b>× {{ p.quantite }}</b>
          </li>
        </ul>
        <p class="discret">Remplissage {{ devis.reglages.remplissage_pct }} % · {{ devis.reglages.couches_surface }} couches de surface ·
          {{ PROPRETES[devis.reglages.proprete] }}</p>
      </div>

      <div v-if="devis.statut === 'pret'" class="carte">
        <h2>Aperçu de l'impression</h2>
        <p class="discret">Découpé par OrcaSlicer avec tes réglages : c'est exactement ce que l'imprimante fera.
          Fais glisser le curseur pour voir chaque couche.</p>
        <ApercuGcode :devis-id="devis.id" />
        <p class="discret">{{ devis.nb_couches }} couches · impression d'environ {{ duree(devis.duree_s) }}</p>
      </div>

      <div v-if="devis.statut === 'pret'" class="carte prix">
        <div><span>Matière ({{ mm(devis.poids_g) }} g)</span><b>{{ euros(devis.prix_matiere_cts) }}</b></div>
        <div><span>Livraison</span><b>{{ euros(devis.livraison_cts) }}</b></div>
        <div class="total"><span>Total</span><b>{{ euros(devis.total_cts) }}</b></div>
        <button class="primaire" disabled title="Le paiement arrive bientôt">Commander · {{ euros(devis.total_cts) }}</button>
      </div>
      <RouterLink to="/compte" class="lien">Voir tous mes devis et commandes</RouterLink>
    </template>
  </main>
</template>

<style scoped>
.statut { display: flex; flex-direction: column; gap: 4px; border-left: 4px solid var(--accent); }
.statut.erreur { border-left-color: var(--danger); }
.statut span { color: var(--discret); }
.statut .relancer { align-self: flex-start; margin-top: 6px; }
.prix { display: flex; flex-direction: column; gap: 8px; }
.prix div { display: flex; justify-content: space-between; }
.prix .total { font-size: 18px; border-top: 1px solid var(--bord); padding-top: 8px; }
</style>
