<script setup>
// Devis : pièces envoyées, réglages, progression de la découpe, puis (quand le serveur a découpé avec
// OrcaSlicer) aperçu 3D couche par couche, poids, prix et commande. Le client peut supprimer son devis.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api.js';
import ApercuGcode from '../components/ApercuGcode.vue';

const route = useRoute();
const routeur = useRouter();
const devis = ref(null), erreur = ref('');
let minuteur = null;

const STATUTS = {
  attente: ['En file pour la découpe', 'Tes pièces vont être découpées par OrcaSlicer pour calculer le poids exact et le prix.'],
  decoupe: ['Découpe en cours', 'OrcaSlicer prépare l\'impression : calcul du poids et du prix.'],
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
const bientot = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.ceil(s / 60)} min`);

// ----- progression de la découpe (estimation du serveur, avancée ici chaque seconde) -----
const recuLe = ref(Date.now());
const maintenant = ref(Date.now());
const horloge = setInterval(() => { maintenant.value = Date.now(); }, 1000);
const avancement = computed(() => {
  const p = devis.value?.progression;
  if (!p) return null;
  const ecoule = (maintenant.value - recuLe.value) / 1000;
  if (devis.value.statut === 'decoupe') {
    const fait = p.depuis_s + ecoule;
    const reste = p.estimee_s - fait;
    return { pct: Math.min(97, (fait / Math.max(1, p.estimee_s)) * 100),
      texte: reste > 0 ? `Encore environ ${bientot(reste)} (estimation)` : 'Presque terminé… c\'est un peu plus long que prévu.' };
  }
  const debut = Math.max(0, p.attente_s - ecoule);
  return { pct: 0, attente: true,
    texte: p.avant ? `${p.avant} découpe${p.avant > 1 ? 's' : ''} avant la tienne · début dans environ ${bientot(debut)}`
      : 'Démarrage de la découpe…' };
});

async function charger() {
  try {
    devis.value = await api('GET', `/devis/${encodeURIComponent(route.params.id)}`);
    recuLe.value = maintenant.value = Date.now();
    if (['attente', 'decoupe'].includes(devis.value.statut)) minuteur = setTimeout(charger, 4000);
  } catch (e) {
    erreur.value = e.message;
  }
}
onMounted(charger);
onBeforeUnmount(() => { clearTimeout(minuteur); clearInterval(horloge); });

// découpe en erreur : relançable tant que tous les fichiers sont encore là
const relancable = computed(() => devis.value?.statut === 'erreur' && devis.value.pieces.every((p) => p.fichier_disponible));
const relance = ref(false);
// devis déjà payé : plus de bouton « Commander »
const payee = computed(() => devis.value?.commande && !['en_attente_paiement', 'abandonnee'].includes(devis.value.commande.statut));
async function relancer() {
  relance.value = true;
  erreur.value = '';
  try {
    devis.value = await api('POST', `/devis/${encodeURIComponent(devis.value.id)}/relancer`, {});
    recuLe.value = maintenant.value = Date.now();
    clearTimeout(minuteur);
    minuteur = setTimeout(charger, 4000);
  } catch (e) {
    erreur.value = e.message;
  } finally {
    relance.value = false;
  }
}

// suppression : pas pendant la découpe, ni une fois commandé (paiement en cours ou fait)
const supprimable = computed(() => devis.value && devis.value.statut !== 'decoupe'
  && !(devis.value.commande && devis.value.commande.statut !== 'abandonnee'));
const suppression = ref(false);
async function supprimer() {
  if (!window.confirm(`Supprimer le devis ${devis.value.ref} ? Ses fichiers STL et sa découpe seront effacés définitivement.`)) return;
  suppression.value = true;
  erreur.value = '';
  try {
    await api('DELETE', `/devis/${encodeURIComponent(devis.value.id)}`);
    routeur.push('/compte');
  } catch (e) {
    erreur.value = e.message;
    suppression.value = false;
  }
}
</script>

<template>
  <main class="page-texte">
    <p v-if="erreur" class="erreur">{{ erreur }}</p>
    <template v-if="devis">
      <h1>Devis {{ devis.ref }}</h1>
      <div class="carte statut" :class="devis.statut">
        <b>{{ statut[0] }}</b>
        <span v-if="statut[1]">{{ statut[1] }}</span>
        <template v-if="avancement">
          <div class="barre" :class="{ attente: avancement.attente }" role="progressbar" aria-label="Avancement de la découpe"
               aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(avancement.pct)">
            <div class="rempli" :style="{ width: `${avancement.pct}%` }"></div>
          </div>
          <small class="discret">{{ avancement.texte }}</small>
        </template>
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
        <p v-if="payee" class="paye">Commande {{ devis.commande.ref }} payée. <RouterLink to="/compte" class="lien">Suivre ma commande</RouterLink></p>
        <button v-else class="primaire" @click="$router.push(`/commande/${devis.id}`)">Commander · {{ euros(devis.total_cts) }}</button>
      </div>

      <div class="pied">
        <RouterLink to="/compte" class="lien">Voir tous mes devis et commandes</RouterLink>
        <button v-if="supprimable" class="supprimer" :disabled="suppression" @click="supprimer">Supprimer ce devis</button>
      </div>
    </template>
  </main>
</template>

<style scoped>
.statut { display: flex; flex-direction: column; gap: 6px; border-left: 4px solid var(--accent); }
.statut.erreur { border-left-color: var(--danger); }
.statut span { color: var(--discret); }
.statut .relancer { align-self: flex-start; margin-top: 6px; }
.barre { height: 8px; border-radius: 999px; background: var(--fond-champ); overflow: hidden; margin-top: 4px; }
.barre .rempli { height: 100%; border-radius: 999px; background: var(--accent); transition: width 1s linear; }
/* dans la file : bande qui défile (rien n'a encore commencé) */
.barre.attente .rempli { width: 30% !important; animation: file 1.6s ease-in-out infinite; transition: none; }
@keyframes file { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
@media (prefers-reduced-motion: reduce) { .barre.attente .rempli { animation: none; } }
.prix .paye { margin: 0; color: var(--ok); }
.prix { display: flex; flex-direction: column; gap: 8px; }
.prix div { display: flex; justify-content: space-between; }
.prix .total { font-size: 18px; border-top: 1px solid var(--bord); padding-top: 8px; }
.pied { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
.supprimer { color: var(--danger); border-color: var(--bord); background: transparent; padding: 8px 14px; font-size: 14px; }
.supprimer:hover:not(:disabled) { border-color: var(--danger); }
</style>
