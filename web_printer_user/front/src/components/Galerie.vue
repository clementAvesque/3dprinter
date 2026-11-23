<script setup>
// Galerie des projets réalisés : publiés par leurs auteurs (pseudo) une fois la commande validée. Monte du bas de
// l'écran et prend toute la place. Un clic sur un projet pose ses STL sur le plateau de l'atelier (visuel STL) :
// le client y ajuste quantités, taille et réglages, puis clique sur « Découper » comme pour ses propres fichiers.
// Aucun devis n'est créé depuis la galerie.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useAtelier } from '../stores/atelier.js';
import { api } from '../api.js';

const props = defineProps({ ouverte: Boolean });
const emit = defineEmits(['fermer', 'ouvert']);
const atelier = useAtelier();

const projets = ref([]);
const etat = ref('');                 // chargement | pret | erreur
const recherche = ref('');
const ouverture = ref({ id: null, erreur: '', projet: null });   // projet en cours d'ouverture dans l'atelier
const fermer = ref(null);

const mm = (v) => `${Math.round(v * 10) / 10}`.replace('.', ',');
const euros = (cts) => (cts == null ? '—' : `${(cts / 100).toFixed(2).replace('.', ',')} €`);
const nbPieces = (p) => p.pieces.reduce((t, x) => t + x.quantite, 0);
const plusGrande = (p) => p.pieces.reduce((m, x) => (Math.max(...x.dims_mm) > Math.max(...m) ? x.dims_mm : m), [0, 0, 0]);
const ouvrable = (p) => p.ajustable && p.disponible;

const visibles = computed(() => {
  const r = recherche.value.trim().toLowerCase();
  if (!r) return projets.value;
  return projets.value.filter((p) => [p.titre, p.auteur, ...p.pieces.map((x) => x.nom)].some((t) => t.toLowerCase().includes(r)));
});

async function charger() {
  etat.value = 'chargement';
  try {
    projets.value = await api('GET', '/galerie');
    etat.value = 'pret';
  } catch {
    etat.value = 'erreur';
  }
}

// clic sur un projet : ses STL sur le plateau de l'atelier, la galerie se referme pour le montrer
async function ouvrir(p) {
  if (ouverture.value.id || !ouvrable(p)) return;
  ouverture.value = { id: p.id, erreur: '', projet: null };
  try {
    await atelier.ajouterProjet(p);
    ouverture.value = { id: null, erreur: '', projet: null };
    emit('ouvert');
    emit('fermer');
  } catch (e) {
    ouverture.value = { id: null, erreur: e.message, projet: p.id };
  }
}

function touche(e) {
  if (e.key === 'Escape') emit('fermer');
}

watch(() => props.ouverte, async (o) => {
  document.body.style.overflow = o ? 'hidden' : '';
  if (o) {
    window.addEventListener('keydown', touche);
    ouverture.value = { id: null, erreur: '', projet: null };
    if (etat.value !== 'pret') charger();
    await nextTick();
    fermer.value?.focus();
  } else {
    window.removeEventListener('keydown', touche);
  }
});
onBeforeUnmount(() => { window.removeEventListener('keydown', touche); document.body.style.overflow = ''; });
</script>

<template>
  <Transition name="monte">
    <section v-if="ouverte" class="galerie" role="dialog" aria-modal="true" aria-labelledby="galerie-titre">
      <header class="tete">
        <button ref="fermer" class="fermer" type="button" title="Fermer la galerie" @click="emit('fermer')">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4"
            stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="titres">
          <h2 id="galerie-titre">Projets réalisés</h2>
          <p class="discret">Validés par notre atelier et partagés par leurs auteurs. Clique sur un projet : il s'ouvre sur ton plateau,
            tu changes la taille et le nombre d'exemplaires, puis tu découpes.</p>
        </div>
        <input v-if="projets.length" v-model="recherche" class="recherche" type="search" placeholder="Chercher un projet, un auteur…"
               aria-label="Chercher dans la galerie">
      </header>

      <div class="corps">
        <p v-if="etat === 'chargement'" class="discret centre">Chargement des projets…</p>
        <p v-else-if="etat === 'erreur'" class="erreur centre">La galerie n'a pas pu être chargée. <button class="lien" type="button" @click="charger">Réessayer</button></p>
        <div v-else-if="!projets.length" class="vide">
          <b>Aucun projet publié pour l'instant.</b>
          <p class="discret">Ta commande a été validée ? Publie ton projet depuis ton espace compte (onglet Devis) : il apparaîtra ici, signé de ton pseudo.</p>
        </div>
        <p v-else-if="!visibles.length" class="discret centre">Aucun projet ne correspond à « {{ recherche }} ».</p>
        <ul v-else class="grille">
          <li v-for="p in visibles" :key="p.id">
            <button class="projet" type="button" :disabled="!ouvrable(p) || !!ouverture.id" :aria-busy="ouverture.id === p.id"
                    :title="ouvrable(p) ? 'Ouvrir sur mon plateau pour l\'ajuster' : 'Ce projet n\'est plus disponible'" @click="ouvrir(p)">
              <span class="vignette" aria-hidden="true">
                <svg viewBox="0 0 64 64" width="56" height="56"><path d="M32 6l22 12v28L32 58 10 46V18z M32 6v52 M10 18l22 12 22-12" fill="none"
                  stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>
                <small>{{ mm(plusGrande(p)[0]) }} × {{ mm(plusGrande(p)[1]) }} × {{ mm(plusGrande(p)[2]) }} mm</small>
              </span>
              <span class="infos">
                <b class="titre">{{ p.titre }}</b>
                <span class="auteur">par {{ p.auteur }}</span>
                <small class="discret">{{ nbPieces(p) }} pièce(s) · {{ p.poids_g == null ? '' : `${mm(p.poids_g)} g · ` }}{{ euros(p.prix_matiere_cts) }}</small>
                <span class="action">{{ ouverture.id === p.id ? 'Ouverture…' : ouvrable(p) ? 'Ouvrir sur mon plateau →' : 'Indisponible' }}</span>
              </span>
            </button>
            <p v-if="ouverture.projet === p.id && ouverture.erreur" class="erreur petit" role="alert">{{ ouverture.erreur }}</p>
          </li>
        </ul>
      </div>
    </section>
  </Transition>
</template>

<style scoped>
.galerie { position: fixed; inset: 0; z-index: 40; display: flex; flex-direction: column; background: var(--fond); }
.monte-enter-active, .monte-leave-active { transition: transform .35s cubic-bezier(.2, .8, .2, 1); }
.monte-enter-from, .monte-leave-to { transform: translateY(100%); }
@media (prefers-reduced-motion: reduce) { .monte-enter-active, .monte-leave-active { transition: none; } }

.tete { display: flex; align-items: center; gap: 14px; padding: 14px 20px; border-bottom: 1px solid var(--bord); background: var(--fond-carte); flex-wrap: wrap; }
.titres { flex: 1; min-width: 220px; }
.titres h2 { margin: 0; font-size: 20px; }
.titres p { margin: 2px 0 0; font-size: 14px; }
.fermer { display: grid; place-items: center; width: 42px; height: 42px; padding: 0; border-radius: 50%; }
.fermer:hover { border-color: var(--accent); color: var(--accent); }
.recherche { max-width: 300px; }

.corps { flex: 1; overflow: auto; padding: 20px; }
.centre { text-align: center; margin-top: 40px; }
.vide { max-width: 460px; margin: 60px auto; text-align: center; display: flex; flex-direction: column; gap: 8px; }

.grille { list-style: none; margin: 0 auto; padding: 0; max-width: 1400px; display: grid; gap: 14px;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); }
.grille li { display: flex; flex-direction: column; gap: 6px; }
.projet { width: 100%; height: 100%; padding: 0; display: flex; flex-direction: column; text-align: left; overflow: hidden; border-radius: 16px;
  border: 1px solid var(--bord); background: var(--fond-carte); transition: border-color .15s, transform .15s, box-shadow .15s; }
.projet:not(:disabled):hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 10px 26px rgba(0, 0, 0, .12); }
.projet[aria-busy="true"] { border-color: var(--accent); opacity: 1; }
.vignette { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; aspect-ratio: 4 / 3; color: var(--accent);
  background: radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--accent) 14%, var(--fond-vue)), var(--fond-vue)); }
.vignette small { color: var(--discret); font-size: 12px; }
.infos { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px 14px; min-width: 0; }
.titre { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.auteur { color: var(--accent); font-size: 13px; }
.action { margin-top: 6px; font-size: 13px; font-weight: 600; color: var(--accent); }
.petit { font-size: 13px; margin: 0; }

@media (max-width: 860px) {
  .tete { padding: 12px 16px; }
  .corps { padding: 16px; }
  .recherche { max-width: none; }
  .grille { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
}
</style>
