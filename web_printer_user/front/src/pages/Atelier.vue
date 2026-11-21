<script setup>
// Atelier : dépôt des STL, rangement automatique sur le plateau de l'imprimante la plus adaptée,
// réglages, puis « Découper » (connexion demandée à ce moment-là seulement).
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Plateau3D from '../components/Plateau3D.vue';
import PopupReglages from '../components/PopupReglages.vue';
import ModaleConnexion from '../components/ModaleConnexion.vue';
import { useAtelier } from '../stores/atelier.js';
import { useSession } from '../stores/session.js';
import { api, envoyerStl } from '../api.js';

const atelier = useAtelier();
const session = useSession();
const routeur = useRouter();
const survol = ref(false);
const reglagesOuverts = ref(false);
const connexionOuverte = ref(false);
const envoi = ref(null);           // { etape, pct } pendant l'envoi
const erreur = ref('');
const champ = ref(null);
const montee = ref(false);

onMounted(async () => {
  montee.value = true;
  try { await atelier.chargerImprimantes(); } catch (e) { erreur.value = e.message; }
});

const plateau = computed(() => atelier.imprimante?.plateau_mm || atelier.imprimantes[0]?.plateau_mm || [250, 250, 260]);
const PROPRETES = { fine: 'Fine · 0,2 mm + lissage', rapide: 'Rapide · 0,28 mm' };
const mm = (v) => `${Math.round(v * 10) / 10}`.replace('.', ',');
const peutDecouper = computed(() => atelier.pieces.length > 0 && !!atelier.imprimante && !atelier.trop_grandes.length && !envoi.value);

function deposer(ev) {
  survol.value = false;
  atelier.ajouter([...(ev.dataTransfer?.files || [])]);
}
function choisir(ev) {
  atelier.ajouter([...ev.target.files]);
  ev.target.value = '';
}
function appliquerReglages(r) {
  atelier.reglages = r;
  reglagesOuverts.value = false;
}

async function decouper() {
  erreur.value = '';
  if (!session.client) { connexionOuverte.value = true; return; }
  const pieces = atelier.pieces;
  const premiere = new Map(atelier.rangement.places.filter((p) => p.n === 0).map((p) => [p.id, p]));
  try {
    const ids = [];
    for (const [i, p] of pieces.entries()) {
      envoi.value = { etape: `Envoi de ${p.nom} (${i + 1}/${pieces.length})`, pct: 0 };
      const f = await envoyerStl(p.fichier, (x) => { envoi.value.pct = Math.round(x * 100); });
      ids.push(f.id);
    }
    envoi.value = { etape: 'Création du devis', pct: 100 };
    const devis = await api('POST', '/devis', {
      imprimante_id: atelier.imprimante.id,
      reglages: atelier.reglages,
      pieces: pieces.map((p, i) => {
        const pl = premiere.get(p.id);
        return { fichier_id: ids[i], quantite: p.quantite, ...(pl ? { pos_mm: [pl.x, pl.y], rotation_deg: pl.rot } : {}) };
      }),
    });
    atelier.vider();
    routeur.push(`/devis/${devis.id}`);
  } catch (e) {
    if (e.code === 'non_connecte') { session.client = null; connexionOuverte.value = true; }
    erreur.value = e.message;
  } finally {
    envoi.value = null;
  }
}

function apresConnexion() {
  connexionOuverte.value = false;
  decouper();
}
</script>

<template>
  <Teleport v-if="montee" to="#actions-entete">
    <button class="primaire decouper" :disabled="!peutDecouper" @click="decouper">
      {{ envoi ? 'Envoi…' : 'Découper' }}
    </button>
  </Teleport>

  <main class="atelier">
    <section class="colonne-gauche">
      <div class="depot" :class="{ survol }" role="button" tabindex="0"
           @dragover.prevent="survol = true" @dragleave="survol = false" @drop.prevent="deposer"
           @click="champ.click()" @keydown.enter.prevent="champ.click()">
        <input ref="champ" type="file" accept=".stl" multiple hidden @change="choisir">
        <b>Glisse tes fichiers STL ici</b>
        <span>ou clique pour les choisir · plusieurs fichiers possibles · 50 Mo max chacun</span>
      </div>

      <ul v-if="atelier.erreurs.length" class="erreurs">
        <li v-for="e in atelier.erreurs" :key="e" class="erreur">{{ e }}</li>
      </ul>

      <ul v-if="atelier.pieces.length" class="pieces">
        <li v-for="p in atelier.pieces" :key="p.id">
          <div class="nom-piece">
            <b :title="p.nom">{{ p.nom }}</b>
            <small>{{ mm(p.dims[0]) }} × {{ mm(p.dims[1]) }} × {{ mm(p.dims[2]) }} mm</small>
            <small v-if="atelier.trop_grandes.includes(p)" class="erreur">trop grande pour nos imprimantes</small>
          </div>
          <div class="quantite" aria-label="quantité">
            <button class="icone" :disabled="p.quantite <= 1" aria-label="moins" @click="p.quantite--">−</button>
            <span>{{ p.quantite }}</span>
            <button class="icone" :disabled="p.quantite >= 50" aria-label="plus" @click="p.quantite++">+</button>
          </div>
          <button class="icone" aria-label="retirer" title="retirer" @click="atelier.retirer(p.id)">✕</button>
        </li>
      </ul>

      <div class="carte reglages">
        <div>
          <h2>Réglages</h2>
          <p>Remplissage {{ atelier.reglages.remplissage_pct }} % · {{ atelier.reglages.couches_surface }} couches de surface</p>
          <p>Propreté : {{ PROPRETES[atelier.reglages.proprete] }}</p>
        </div>
        <button class="secondaire" @click="reglagesOuverts = true">Modifier</button>
      </div>

      <p v-if="envoi" class="info">{{ envoi.etape }} <b>{{ envoi.pct }} %</b></p>
      <p v-if="erreur" class="erreur" role="alert">{{ erreur }}</p>
      <p class="discret">Le poids et le prix exacts sont calculés au moment de la découpe.
        Expédition sous 2 semaines en général, 2 mois au plus.</p>
    </section>

    <section class="vue">
      <Plateau3D :plateau="plateau" :pieces="atelier.pieces" :places="atelier.rangement.places" :hors="atelier.rangement.hors" />
      <div class="legende-vue">
        <span v-if="atelier.imprimante">{{ atelier.imprimante.nom }} · plateau {{ plateau[0] }} × {{ plateau[1] }} mm</span>
        <span v-if="atelier.rangement.hors.length" class="erreur">
          {{ atelier.rangement.hors.length }} pièce(s) ne rentrent pas sur un seul plateau : elles seront imprimées en plusieurs fois.
        </span>
        <span v-else-if="!atelier.pieces.length">Tes pièces apparaîtront ici, rangées automatiquement.</span>
      </div>
    </section>
  </main>

  <PopupReglages :ouvert="reglagesOuverts" :reglages="atelier.reglages"
                 @fermer="reglagesOuverts = false" @valider="appliquerReglages" />
  <ModaleConnexion :ouvert="connexionOuverte" @fermer="connexionOuverte = false" @connecte="apresConnexion" />
</template>

<style scoped>
.atelier { display: grid; grid-template-columns: minmax(300px, 380px) 1fr; gap: 20px; padding: 20px; width: 100%; max-width: 1500px;
  margin: 0 auto; min-height: calc(100vh - 130px); }
.colonne-gauche { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.depot { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 30px 16px; text-align: center; cursor: pointer;
  border: 2px dashed var(--bord-fort); border-radius: 16px; background: var(--fond-carte); transition: border-color .15s, background .15s; }
.depot span { color: var(--discret); font-size: 13px; }
.depot.survol, .depot:hover, .depot:focus-visible { border-color: var(--accent); outline: none;
  background: color-mix(in srgb, var(--accent) 7%, var(--fond-carte)); }
.pieces { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.pieces li { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--bord); border-radius: 12px;
  background: var(--fond-carte); }
.nom-piece { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.nom-piece b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nom-piece small { color: var(--discret); }
.quantite { display: flex; align-items: center; gap: 4px; }
.quantite span { min-width: 24px; text-align: center; font-variant-numeric: tabular-nums; }
.reglages { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.reglages h2 { margin: 0 0 4px; font-size: 16px; }
.reglages p { margin: 0; color: var(--discret); font-size: 13px; }
.erreurs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.vue { position: relative; min-height: 420px; border: 1px solid var(--bord); border-radius: 16px; overflow: hidden; background: var(--fond-vue); }
.legende-vue { position: absolute; left: 12px; bottom: 12px; right: 12px; display: flex; flex-direction: column; gap: 4px;
  font-size: 13px; color: var(--discret); pointer-events: none; }
.decouper { min-width: 120px; }
@media (max-width: 860px) {
  .atelier { grid-template-columns: minmax(0, 1fr); padding: 12px 16px; }
  .vue { min-height: 60vh; order: -1; }
}
</style>
