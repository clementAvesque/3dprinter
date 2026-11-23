<script setup>
// Atelier : dépôt des STL, rangement automatique sur le plateau de l'imprimante la plus adaptée,
// réglages, puis « Découper » (connexion demandée à ce moment-là seulement).
// Le plateau 3D occupe tout l'écran ; le reste est dans un panneau repliable (à gauche, en bas sur téléphone).
// La flèche du bas ouvre la galerie des projets réalisés par les autres clients.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Plateau3D from '../components/Plateau3D.vue';
import PopupReglages from '../components/PopupReglages.vue';
import ModaleConnexion from '../components/ModaleConnexion.vue';
import Galerie from '../components/Galerie.vue';
import { useAtelier, ECHELLE_MIN, ECHELLE_MAX } from '../stores/atelier.js';
import { couleurPiece } from '../lib/couleurs.js';
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

// panneau repliable (choix gardé par le navigateur) et zones du plateau qu'il couvre
const lire = (cle) => { try { return localStorage.getItem(cle); } catch { return null; } };
const replie = ref(lire('atelier.replie') === '1');
watch(replie, (v) => { try { localStorage.setItem('atelier.replie', v ? '1' : '0'); } catch { /* navigation privée */ } });
const panneau = ref(null);
const marges = ref({ gauche: 0, haut: 0, bas: 0 });
const telephone = ref(false);
const galerieOuverte = ref(false);
let observateur;
function mesurer() {
  const p = panneau.value?.getBoundingClientRect();
  const entete = document.querySelector('.entete')?.offsetHeight || 0;
  telephone.value = window.innerWidth <= 860;
  if (!p) return;
  marges.value = telephone.value
    ? { gauche: 0, haut: entete, bas: replie.value ? 56 : Math.max(0, window.innerHeight - p.top) }
    : { gauche: replie.value ? 0 : p.right + 8, haut: entete, bas: 0 };
}
watch(replie, () => setTimeout(mesurer, 260));          // après l'animation du panneau

onMounted(async () => {
  montee.value = true;
  observateur = new ResizeObserver(mesurer);
  observateur.observe(panneau.value);
  window.addEventListener('resize', mesurer);
  mesurer();
  try { await atelier.chargerImprimantes(); } catch (e) { erreur.value = e.message; }
});
onBeforeUnmount(() => {
  observateur?.disconnect();
  window.removeEventListener('resize', mesurer);
});

const plateau = computed(() => atelier.imprimante?.plateau_mm || atelier.imprimantes[0]?.plateau_mm || [250, 250, 260]);
const PROPRETES = { fine: 'Fine · 0,2 mm + lissage', rapide: 'Rapide · 0,28 mm' };
const mm = (v) => `${Math.round(v * 10) / 10}`.replace('.', ',');
const peutDecouper = computed(() => atelier.pieces.length > 0 && !!atelier.imprimante && !atelier.trop_grandes.length
  && !atelier.trop_petites.length && !envoi.value);

// pièce sélectionnée (clic dans la liste ou sur le plateau 3D) et son multiplicateur de taille
const choisie = computed(() => atelier.pieces.find((p) => p.id === atelier.selection) || null);
const ECHELLES = [[1, '×1', 'mm'], [10, '×10', 'cm'], [25.4, '×25,4', 'pouces'], [1000, '×1000', 'mètres']];
const echelleTexte = ref('');
function regler(id, valeur) {
  const v = Number(String(valeur).replace(',', '.'));
  if (!atelier.changerEchelle(id, v)) erreur.value = `Multiplicateur de ${ECHELLE_MIN} à ${ECHELLE_MAX}.`;
  else erreur.value = '';
}
const fois = (v) => `×${String(Math.round(v * 1000) / 1000).replace('.', ',')}`;

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
    // pièces ouvertes depuis la galerie : déjà sur le serveur, désignées par projet + numéro (pas d'envoi)
    const aEnvoyer = pieces.filter((p) => !p.projet);
    const ids = new Map();
    for (const [i, p] of aEnvoyer.entries()) {
      envoi.value = { etape: `Envoi de ${p.nom} (${i + 1}/${aEnvoyer.length})`, pct: 0 };
      const f = await envoyerStl(p.fichier, (x) => { envoi.value.pct = Math.round(x * 100); });
      ids.set(p.id, f.id);
    }
    envoi.value = { etape: 'Création du devis', pct: 100 };
    const devis = await api('POST', '/devis', {
      imprimante_id: atelier.imprimante.id,
      reglages: atelier.reglages,
      pieces: pieces.map((p) => {
        const pl = premiere.get(p.id);
        return { ...(p.projet ? { projet_id: p.projet.id, piece: p.projet.n } : { fichier_id: ids.get(p.id) }),
          quantite: p.quantite, echelle: p.echelle, ...(pl ? { pos_mm: [pl.x, pl.y], rotation_deg: pl.rot } : {}) };
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

  <main class="atelier" :class="{ replie }">
    <!-- le plateau 3D : fond de toute la page -->
    <section class="scene">
      <Plateau3D :plateau="plateau" :pieces="atelier.pieces" :places="atelier.rangement.places" :hors="atelier.rangement.hors"
                 :selection="atelier.selection" :marges="marges" @choisir="(id) => (atelier.selection = id)" />
    </section>

    <div class="infos-vue" :style="{ left: `${marges.gauche + (telephone ? 16 : replie ? 160 : 56)}px`, top: `${marges.haut + 14}px` }">
      <div v-if="choisie" class="etiquette">
        <b>{{ choisie.nom }}</b>
        <span>{{ mm(choisie.dims[0]) }} × {{ mm(choisie.dims[1]) }} × {{ mm(choisie.dims[2]) }} mm · × {{ choisie.quantite }}</span>
      </div>
      <div class="legende-vue">
        <span v-if="atelier.imprimante">{{ atelier.imprimante.nom }} · plateau {{ plateau[0] }} × {{ plateau[1] }} mm</span>
        <span v-if="atelier.rangement.hors.length" class="erreur">
          {{ atelier.rangement.hors.length }} pièce(s) ne rentrent pas sur un seul plateau : elles seront imprimées en plusieurs fois.
        </span>
        <span v-else-if="!atelier.pieces.length">Tes pièces apparaîtront ici, rangées automatiquement.</span>
        <span v-else-if="!choisie">Clique sur une pièce pour l'identifier.</span>
      </div>
    </div>

    <!-- tout le reste : panneau repliable pour voir les pièces en grand -->
    <aside ref="panneau" class="panneau" :aria-label="replie ? 'Panneau replié' : 'Pièces et réglages'">
      <button class="poignee" type="button" :aria-expanded="!replie" :title="replie ? 'Afficher le panneau' : 'Replier le panneau (voir les pièces en grand)'"
              @click="replie = !replie">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path :d="telephone ? (replie ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6') : (replie ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6')"
          fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="poignee-texte">{{ replie ? `Mes pièces${atelier.pieces.length ? ` (${atelier.pieces.length})` : ''}` : 'Replier' }}</span>
      </button>

      <div class="contenu">
        <div class="depot" :class="{ survol }" role="button" tabindex="0"
             @dragover.prevent="survol = true" @dragleave="survol = false" @drop.prevent="deposer"
             @click="champ.click()" @keydown.enter.prevent="champ.click()">
          <input ref="champ" type="file" accept=".stl" multiple hidden @change="choisir">
          <b>Glisse tes fichiers STL ici</b>
          <span>ou clique pour les choisir · plusieurs fichiers possibles · 100 Mo max chacun</span>
        </div>

        <ul v-if="atelier.erreurs.length" class="erreurs">
          <li v-for="e in atelier.erreurs" :key="e" class="erreur">{{ e }}</li>
        </ul>

        <ul v-if="atelier.pieces.length" class="pieces">
          <li v-for="(p, i) in atelier.pieces" :key="p.id" :class="{ choisie: p.id === atelier.selection }"
              :ref="(el) => { if (el && p.id === atelier.selection) el.scrollIntoView({ block: 'nearest' }); }">
            <div class="ligne-piece">
              <button class="pastille" :style="{ background: couleurPiece(i) }" :aria-pressed="p.id === atelier.selection"
                      :aria-label="`identifier ${p.nom} sur le plateau`" title="montrer sur le plateau" @click="atelier.choisir(p.id)"></button>
              <div class="nom-piece" @click="atelier.choisir(p.id)">
                <b :title="p.nom">{{ p.nom }}</b>
                <small>{{ mm(p.dims[0]) }} × {{ mm(p.dims[1]) }} × {{ mm(p.dims[2]) }} mm<template v-if="p.echelle !== 1"> · taille {{ fois(p.echelle) }}</template></small>
                <small v-if="p.projet" class="info-auto">d'après « {{ p.projet.titre }} » de {{ p.projet.auteur }}</small>
                <small v-if="p.auto" class="info-auto">Fichier en mètres ? Taille multipliée par 1000 automatiquement.</small>
                <small v-if="atelier.trop_grandes.includes(p)" class="erreur">trop grande pour le plateau (bordures comprises)<template
                  v-if="atelier.echelleMax(p) >= ECHELLE_MIN"> : taille {{ fois(atelier.echelleMax(p)) }} au plus.
                  <button class="lien" type="button" @click.stop="regler(p.id, atelier.echelleMax(p))">Appliquer</button></template></small>
                <small v-if="atelier.trop_petites.includes(p)" class="erreur">moins d'1 mm : augmente le multiplicateur de taille</small>
              </div>
              <div class="quantite" aria-label="quantité">
                <button class="icone" :disabled="p.quantite <= 1" aria-label="moins" @click="p.quantite--">−</button>
                <span>{{ p.quantite }}</span>
                <button class="icone" :disabled="p.quantite >= 50" aria-label="plus" @click="p.quantite++">+</button>
              </div>
              <button class="icone" aria-label="retirer" title="retirer" @click="atelier.retirer(p.id)">✕</button>
            </div>
            <div v-if="p.id === atelier.selection" class="echelle">
              <span>Taille du fichier</span>
              <div class="choix-echelle" role="group" aria-label="multiplicateur de taille">
                <button v-for="[v, t, u] in ECHELLES" :key="v" type="button" :class="{ actif: p.echelle === v }" :title="`fichier en ${u}`"
                        @click="regler(p.id, v)">{{ t }}<small>{{ u }}</small></button>
              </div>
              <label class="libre">Autre ×
                <input :value="p.echelle" inputmode="decimal" aria-label="multiplicateur libre" @change="regler(p.id, $event.target.value)">
              </label>
            </div>
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
        <p class="discret petit">Le poids et le prix exacts sont calculés au moment de la découpe.
          Expédition sous 2 semaines en général, 2 mois au plus.</p>
        <nav class="liens-legaux">
          <RouterLink to="/cgv">CGV</RouterLink>
          <RouterLink to="/mentions-legales">Mentions légales</RouterLink>
          <RouterLink to="/confidentialite">Confidentialité</RouterLink>
        </nav>
      </div>
    </aside>

    <!-- flèche du bas : la galerie des projets réalisés monte et prend toute la place -->
    <button class="fleche-galerie" type="button" :style="telephone ? { bottom: `${marges.bas + 12}px` } : { left: `calc(50% + ${marges.gauche / 2}px)` }"
            aria-haspopup="dialog" @click="galerieOuverte = true">
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.4"
        stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span>Projets réalisés</span>
    </button>
  </main>

  <Galerie :ouverte="galerieOuverte" @fermer="galerieOuverte = false" @ouvert="replie = false" />
  <PopupReglages :ouvert="reglagesOuverts" :reglages="atelier.reglages"
                 @fermer="reglagesOuverts = false" @valider="appliquerReglages" />
  <ModaleConnexion :ouvert="connexionOuverte" @fermer="connexionOuverte = false" @connecte="apresConnexion" />
</template>

<style scoped>
/* plateau 3D en fond : tout l'écran, sous l'en-tête (posée dessus, translucide) */
.atelier { position: relative; min-height: calc(100vh - 60px); }
.scene { position: fixed; inset: 0; z-index: 0; background: radial-gradient(ellipse at 60% 40%, color-mix(in srgb, var(--fond-vue) 70%, var(--fond-carte)), var(--fond-vue)); }

/* panneau : à gauche, repliable vers la gauche ; sa poignée reste visible */
.panneau { position: fixed; z-index: 5; top: 72px; left: 16px; bottom: 16px; width: min(380px, calc(100vw - 32px));
  display: flex; flex-direction: column; border-radius: 18px; border: 1px solid var(--bord);
  background: color-mix(in srgb, var(--fond-carte) 88%, transparent); backdrop-filter: blur(14px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, .18); transition: transform .25s ease; }
.replie .panneau { transform: translateX(calc(-100% - 16px)); }
.poignee { position: absolute; top: 14px; right: -46px; display: flex; align-items: center; gap: 6px; padding: 9px 10px;
  border-radius: 0 12px 12px 0; border: 1px solid var(--bord); border-left: 0;
  background: color-mix(in srgb, var(--fond-carte) 92%, transparent); backdrop-filter: blur(14px); color: var(--texte); }
.poignee-texte { display: none; }
.replie .poignee { right: -132px; border-radius: 0 12px 12px 0; }
.replie .poignee-texte { display: inline; font-size: 13px; font-weight: 600; white-space: nowrap; }
.contenu { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 14px; padding: 16px; overscroll-behavior: contain; }

.infos-vue { position: fixed; z-index: 2; right: 16px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
  pointer-events: none; transition: left .25s ease; }
.etiquette { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border-radius: 10px; max-width: 100%;
  background: color-mix(in srgb, var(--fond-carte) 92%, transparent); border: 1px solid var(--accent); font-size: 13px; }
.etiquette b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.etiquette span { color: var(--discret); }
.legende-vue { display: flex; flex-direction: column; gap: 4px; padding: 6px 10px; border-radius: 10px; font-size: 13px; color: var(--discret);
  background: color-mix(in srgb, var(--fond-carte) 70%, transparent); }

.fleche-galerie { position: fixed; z-index: 4; bottom: 18px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px;
  padding: 10px 18px 10px 14px; border-radius: 999px; border: 1px solid var(--bord); font-weight: 600; color: var(--texte);
  background: color-mix(in srgb, var(--fond-carte) 90%, transparent); backdrop-filter: blur(12px); box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
  transition: left .25s ease, bottom .25s ease; }
.fleche-galerie svg { animation: monter 2.4s ease-in-out infinite; }
.fleche-galerie:hover { border-color: var(--accent); color: var(--accent); }
@keyframes monter { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .fleche-galerie svg { animation: none; } .panneau, .infos-vue, .fleche-galerie { transition: none; } }

.depot { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 26px 16px; text-align: center; cursor: pointer;
  border: 2px dashed var(--bord-fort); border-radius: 16px; background: var(--fond-carte); transition: border-color .15s, background .15s; }
.depot span { color: var(--discret); font-size: 13px; }
.depot.survol, .depot:hover, .depot:focus-visible { border-color: var(--accent); outline: none;
  background: color-mix(in srgb, var(--accent) 7%, var(--fond-carte)); }
.pieces { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.pieces li { display: flex; flex-direction: column; gap: 10px; padding: 10px 12px; border: 1px solid var(--bord); border-radius: 12px;
  background: var(--fond-carte); }
.pieces li.choisie { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ligne-piece { display: flex; align-items: center; gap: 10px; }
.pastille { flex: none; width: 16px; height: 16px; padding: 0; border-radius: 50%; border: 2px solid var(--fond-carte);
  box-shadow: 0 0 0 1px var(--bord-fort); }
.pastille[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--accent); }
.nom-piece { display: flex; flex-direction: column; min-width: 0; flex: 1; cursor: pointer; }
.nom-piece b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nom-piece small { color: var(--discret); }
.info-auto { color: var(--accent) !important; }
.echelle { display: flex; flex-direction: column; gap: 6px; padding-top: 8px; border-top: 1px solid var(--bord); font-size: 13px; }
.echelle > span { color: var(--discret); }
.choix-echelle { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.choix-echelle button { display: flex; flex-direction: column; align-items: center; padding: 6px 4px; font-size: 13px; border-radius: 8px; }
.choix-echelle button small { color: var(--discret); font-size: 11px; }
.choix-echelle button.actif { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--fond-carte)); }
.libre { display: flex; align-items: center; gap: 6px; color: var(--discret); }
.libre input { width: 90px; padding: 6px 8px; }
.quantite { display: flex; align-items: center; gap: 4px; }
.quantite span { min-width: 24px; text-align: center; font-variant-numeric: tabular-nums; }
.reglages { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.reglages h2 { margin: 0 0 4px; font-size: 16px; }
.reglages p { margin: 0; color: var(--discret); font-size: 13px; }
.erreurs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.petit { font-size: 13px; margin: 0; }
.liens-legaux { display: flex; flex-wrap: wrap; gap: 14px; margin-top: auto; padding-top: 8px; font-size: 12px; }
.liens-legaux a { color: var(--discret); text-decoration: none; }
.liens-legaux a:hover { color: var(--texte); }
.decouper { min-width: 120px; }

/* téléphone : panneau en bas, replié jusqu'à sa poignée */
@media (max-width: 860px) {
  .panneau { top: auto; left: 0; right: 0; bottom: 0; width: auto; max-height: 58vh; border-radius: 18px 18px 0 0; border-bottom: 0; }
  .replie .panneau { transform: translateY(calc(100% - 52px)); }
  .poignee, .replie .poignee { position: static; justify-content: center; width: 100%; border: 0; border-bottom: 1px solid var(--bord);
    border-radius: 18px 18px 0 0; background: transparent; backdrop-filter: none; min-height: 52px; }
  .poignee-texte { display: inline; font-size: 13px; font-weight: 600; }
  .contenu { padding: 12px 16px 16px; }
  .fleche-galerie { left: 50%; }
  .infos-vue { right: 16px; }
}
</style>
