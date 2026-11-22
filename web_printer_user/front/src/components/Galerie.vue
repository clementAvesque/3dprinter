<script setup>
// Galerie des projets réalisés : publiés par leurs auteurs (pseudo), imprimés pour de vrai. Monte du bas de
// l'écran et prend toute la place. Choisir un projet crée un devis à son nom (mêmes pièces, mêmes réglages),
// découpé par le serveur, à commander seul ou avec ses autres devis. Les STL ne quittent jamais le serveur.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import ApercuGcode from './ApercuGcode.vue';
import ModaleConnexion from './ModaleConnexion.vue';
import { useSession } from '../stores/session.js';
import { api } from '../api.js';

const props = defineProps({ ouverte: Boolean });
const emit = defineEmits(['fermer']);
const session = useSession();
const routeur = useRouter();

const projets = ref([]);
const etat = ref('');                 // chargement | pret | erreur
const choisi = ref(null);             // projet affiché en détail
const recherche = ref('');
const ajout = ref({ occupe: false, erreur: '', devis: null });
const connexionOuverte = ref(false);
const fermer = ref(null);

const PROPRETES = { fine: 'Fine · 0,2 mm + lissage', rapide: 'Rapide · 0,28 mm' };
const mm = (v) => `${Math.round(v * 10) / 10}`.replace('.', ',');
const euros = (cts) => (cts == null ? '—' : `${(cts / 100).toFixed(2).replace('.', ',')} €`);
const duree = (s) => { if (!s) return '—'; const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`; };
const date = (ms) => new Date(ms).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
const nbPieces = (p) => p.pieces.reduce((t, x) => t + x.quantite, 0);
const plusGrande = (p) => p.pieces.reduce((m, x) => (Math.max(...x.dims_mm) > Math.max(...m) ? x.dims_mm : m), [0, 0, 0]);

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

function voir(p) {
  choisi.value = p;
  ajout.value = { occupe: false, erreur: '', devis: null };
}

async function ajouter() {
  if (!session.client) { connexionOuverte.value = true; return; }
  ajout.value = { occupe: true, erreur: '', devis: null };
  try {
    const d = await api('POST', `/galerie/${choisi.value.id}/devis`, {});
    ajout.value = { occupe: false, erreur: '', devis: d };
    choisi.value.choisie++;
  } catch (e) {
    if (e.code === 'non_connecte') { session.client = null; connexionOuverte.value = true; }
    ajout.value = { occupe: false, erreur: e.message, devis: null };
  }
}

function apresConnexion() {
  connexionOuverte.value = false;
  ajouter();
}

function allerA(chemin) {
  emit('fermer');
  routeur.push(chemin);
}

// Échap : retour à la liste, puis fermeture
function touche(e) {
  if (e.key !== 'Escape' || connexionOuverte.value) return;
  if (choisi.value) choisi.value = null;
  else emit('fermer');
}

watch(() => props.ouverte, async (o) => {
  document.body.style.overflow = o ? 'hidden' : '';
  if (o) {
    window.addEventListener('keydown', touche);
    if (etat.value !== 'pret') charger();
    await nextTick();
    fermer.value?.focus();
  } else {
    window.removeEventListener('keydown', touche);
    choisi.value = null;
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
          <p class="discret">Imprimés pour nos clients et partagés par leurs auteurs. Un projet te plaît ? On le découpe pour toi.</p>
        </div>
        <input v-if="!choisi && projets.length" v-model="recherche" class="recherche" type="search" placeholder="Chercher un projet, un auteur…"
               aria-label="Chercher dans la galerie">
      </header>

      <div class="corps">
        <!-- détail d'un projet -->
        <div v-if="choisi" class="detail">
          <button class="lien retour" type="button" @click="choisi = null">← Tous les projets</button>
          <div class="detail-grille">
            <ApercuGcode :key="choisi.id" :source="`/api/client/galerie/${choisi.id}`" />
            <div class="fiche">
              <div>
                <h3>{{ choisi.titre }}</h3>
                <p class="auteur">par <b>{{ choisi.auteur }}</b> · publié en {{ date(choisi.cree_le) }}</p>
              </div>
              <ul class="pieces">
                <li v-for="(x, i) in choisi.pieces" :key="i">
                  <span>{{ x.nom }}</span>
                  <small class="discret">{{ mm(x.dims_mm[0]) }} × {{ mm(x.dims_mm[1]) }} × {{ mm(x.dims_mm[2]) }} mm</small>
                  <b>× {{ x.quantite }}</b>
                </li>
              </ul>
              <dl class="chiffres">
                <div><dt>Matière</dt><dd>{{ choisi.poids_g == null ? '—' : `${mm(choisi.poids_g)} g` }}</dd></div>
                <div><dt>Impression</dt><dd>{{ duree(choisi.duree_s) }}</dd></div>
                <div><dt>Prix indicatif</dt><dd>{{ euros(choisi.prix_matiere_cts) }}</dd></div>
              </dl>
              <p class="discret petit">{{ PROPRETES[choisi.reglages.proprete] }} · remplissage {{ choisi.reglages.remplissage_pct }} %.
                Le prix exact (et la livraison) est calculé à la découpe de ton devis.</p>

              <template v-if="ajout.devis">
                <p class="info">Devis créé d'après le projet de {{ choisi.auteur }} : il est en cours de découpe. Commande-le seul, ou avec tes autres devis depuis ton compte.</p>
                <div class="actions">
                  <button class="primaire" type="button" @click="allerA(`/devis/${ajout.devis.id}`)">Voir mon devis</button>
                  <button class="secondaire" type="button" @click="choisi = null">Continuer à regarder</button>
                </div>
              </template>
              <template v-else>
                <p v-if="ajout.erreur" class="erreur" role="alert">{{ ajout.erreur }}</p>
                <button class="primaire grand" type="button" :disabled="ajout.occupe || !choisi.disponible" @click="ajouter">
                  {{ ajout.occupe ? 'Création du devis…' : session.client ? 'Ajouter à mes devis' : 'Se connecter pour l\'ajouter' }}
                </button>
                <p v-if="choisi.choisie" class="discret petit">Déjà choisi {{ choisi.choisie }} fois.</p>
              </template>
            </div>
          </div>
        </div>

        <!-- liste des projets -->
        <template v-else>
          <p v-if="etat === 'chargement'" class="discret centre">Chargement des projets…</p>
          <p v-else-if="etat === 'erreur'" class="erreur centre">La galerie n'a pas pu être chargée. <button class="lien" type="button" @click="charger">Réessayer</button></p>
          <div v-else-if="!projets.length" class="vide">
            <b>Aucun projet publié pour l'instant.</b>
            <p class="discret">Tu as fait imprimer quelque chose ? Publie-le depuis ton espace compte (onglet Devis) : il apparaîtra ici, signé de ton pseudo.</p>
          </div>
          <p v-else-if="!visibles.length" class="discret centre">Aucun projet ne correspond à « {{ recherche }} ».</p>
          <ul v-else class="grille">
            <li v-for="p in visibles" :key="p.id">
              <button class="projet" type="button" @click="voir(p)">
                <span class="vignette" aria-hidden="true">
                  <svg viewBox="0 0 64 64" width="56" height="56"><path d="M32 6l22 12v28L32 58 10 46V18z M32 6v52 M10 18l22 12 22-12" fill="none"
                    stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>
                  <small>{{ mm(plusGrande(p)[0]) }} × {{ mm(plusGrande(p)[1]) }} × {{ mm(plusGrande(p)[2]) }} mm</small>
                </span>
                <span class="infos">
                  <b class="titre">{{ p.titre }}</b>
                  <span class="auteur">par {{ p.auteur }}</span>
                  <small class="discret">{{ nbPieces(p) }} pièce(s) · {{ p.poids_g == null ? '' : `${mm(p.poids_g)} g · ` }}{{ euros(p.prix_matiere_cts) }}</small>
                </span>
              </button>
            </li>
          </ul>
        </template>
      </div>
    </section>
  </Transition>
  <ModaleConnexion :ouvert="connexionOuverte" @fermer="connexionOuverte = false" @connecte="apresConnexion" />
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
.projet { width: 100%; height: 100%; padding: 0; display: flex; flex-direction: column; text-align: left; overflow: hidden; border-radius: 16px;
  border: 1px solid var(--bord); background: var(--fond-carte); transition: border-color .15s, transform .15s, box-shadow .15s; }
.projet:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 10px 26px rgba(0, 0, 0, .12); }
.vignette { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; aspect-ratio: 4 / 3; color: var(--accent);
  background: radial-gradient(circle at 50% 40%, color-mix(in srgb, var(--accent) 14%, var(--fond-vue)), var(--fond-vue)); }
.vignette small { color: var(--discret); font-size: 12px; }
.infos { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px 14px; min-width: 0; }
.titre { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.auteur { color: var(--accent); font-size: 13px; }

.detail { max-width: 1300px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }
.retour { align-self: flex-start; background: none; border: 0; padding: 0; }
.detail-grille { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 20px; align-items: start; }
.fiche { display: flex; flex-direction: column; gap: 14px; padding: 18px; border-radius: 16px; border: 1px solid var(--bord); background: var(--fond-carte); }
.fiche h3 { margin: 0; font-size: 20px; }
.fiche .auteur { margin: 2px 0 0; }
.pieces { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.pieces li { display: flex; align-items: baseline; gap: 10px; padding: 7px 0; border-top: 1px solid var(--bord); flex-wrap: wrap; }
.pieces li:first-child { border-top: 0; }
.pieces li span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.chiffres { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 0; }
.chiffres div { padding: 8px 10px; border-radius: 10px; background: var(--fond-champ); }
.chiffres dt { font-size: 12px; color: var(--discret); }
.chiffres dd { margin: 0; font-weight: 600; }
.petit { font-size: 13px; margin: 0; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.grand { padding: 12px 16px; }

@media (max-width: 860px) {
  .detail-grille { grid-template-columns: minmax(0, 1fr); }
  .tete { padding: 12px 16px; }
  .corps { padding: 16px; }
  .recherche { max-width: none; }
  .grille { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
}
</style>
