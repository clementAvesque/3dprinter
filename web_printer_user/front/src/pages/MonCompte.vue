<script setup>
// Mon compte : devis (et commande groupée de plusieurs devis), commandes, fichiers gardés (et leur suppression),
// déconnexion.
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useSession } from '../stores/session.js';
import { api } from '../api.js';

const session = useSession();
const routeur = useRouter();
const devis = ref([]), commandes = ref([]), fichiers = ref([]), erreur = ref('');

const STATUTS_DEVIS = { attente: 'en file pour la découpe', decoupe: 'découpe en cours', pret: 'prêt', erreur: 'découpe impossible' };
const STATUTS_COMMANDE = {
  en_attente_paiement: 'en attente de paiement', abandonnee: 'abandonnée', payee: 'payée, en vérification',
  validee: 'en préparation', dans_un_lot: 'en préparation', en_impression: 'en préparation', suspendue: 'en préparation',
  imprimee: 'imprimée', expediee: 'expédiée', livree: 'livrée', remboursee: 'remboursée',
};
const date = (ms) => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const euros = (cts) => `${(cts / 100).toFixed(2).replace('.', ',')} €`;

// commande groupée : devis prêts, pas déjà payés, cochés ensemble (un seul colis)
const commandable = (d) => d.statut === 'pret' && (!d.commande || ['en_attente_paiement', 'abandonnee'].includes(d.commande.statut));
const coches = ref([]);
const MAX_GROUPE = 5;                       // devis par commande groupée (limite du serveur)
const nbCommandables = computed(() => devis.value.filter(commandable).length);
function commanderSelection() {
  if (coches.value.length) routeur.push(`/commande/${coches.value.join(',')}`);
}

async function charger() {
  try {
    [devis.value, commandes.value, fichiers.value] = await Promise.all([api('GET', '/devis'), api('GET', '/commandes'), api('GET', '/fichiers')]);
  } catch (e) {
    erreur.value = e.message;
  }
}

async function supprimerFichier(f) {
  if (!confirm(`Supprimer définitivement ${f.nom} ?`)) return;
  try {
    await api('DELETE', `/fichiers/${f.id}`);
    fichiers.value = fichiers.value.filter((x) => x.id !== f.id);
  } catch (e) {
    erreur.value = e.message;
  }
}

async function deconnexion() {
  await session.deconnexion();
  routeur.push('/');
}
onMounted(charger);
</script>

<template>
  <main class="page-texte">
    <div class="titre-ligne">
      <h1>Mon compte</h1>
      <button class="secondaire" @click="deconnexion">Se déconnecter</button>
    </div>
    <p class="discret">{{ session.client?.nom }} · {{ session.client?.email }}</p>
    <p v-if="erreur" class="erreur">{{ erreur }}</p>

    <section class="carte">
      <h2>Commandes</h2>
      <p v-if="!commandes.length" class="discret">Aucune commande pour l'instant.</p>
      <ul class="liste">
        <li v-for="c in commandes" :key="c.id">
          <span>Commande {{ c.ref }} · {{ date(c.cree_le) }}<template v-if="c.devis_ids?.length > 1"> · {{ c.devis_ids.length }} devis</template></span>
          <small class="discret">{{ STATUTS_COMMANDE[c.statut] }}<template v-if="c.numero_suivi"> · suivi {{ c.numero_suivi }}</template></small>
          <b>{{ euros(c.total_cts) }}</b>
        </li>
      </ul>
    </section>

    <section class="carte">
      <h2>Devis</h2>
      <p v-if="!devis.length" class="discret">Aucun devis. <RouterLink to="/" class="lien">Dépose tes STL dans l'atelier.</RouterLink></p>
      <p v-else-if="nbCommandables > 1" class="discret">Un projet sur plusieurs devis ? Coche-les (5 au plus) pour les commander
        ensemble : un seul paiement et un seul colis.</p>
      <ul class="liste">
        <li v-for="d in devis" :key="d.id">
          <label v-if="nbCommandables > 1" class="coche" :class="{ inactive: !commandable(d) }">
            <input v-model="coches" type="checkbox" :value="d.id" :aria-label="`choisir le devis ${d.ref}`"
                   :disabled="!commandable(d) || (coches.length >= MAX_GROUPE && !coches.includes(d.id))">
          </label>
          <RouterLink :to="`/devis/${d.id}`" class="lien">Devis {{ d.ref }}</RouterLink>
          <small class="discret">{{ date(d.cree_le) }} · {{ d.pieces.length }} fichier(s) · {{ STATUTS_DEVIS[d.statut] }}<template
            v-if="d.commande && !['en_attente_paiement', 'abandonnee'].includes(d.commande.statut)"> · commande {{ d.commande.ref }}</template></small>
          <b v-if="d.total_cts != null">{{ euros(d.prix_matiere_cts) }}</b>
        </li>
      </ul>
      <button v-if="nbCommandables > 1" class="primaire commander" :disabled="!coches.length" @click="commanderSelection">
        Commander la sélection<template v-if="coches.length"> ({{ coches.length }} devis)</template>
      </button>
    </section>

    <section class="carte">
      <h2>Mes fichiers</h2>
      <p class="discret">Les fichiers jamais commandés sont supprimés au bout de 30 jours, ceux d'une commande au bout de 2 ans.
        Tu peux les supprimer avant, sauf pendant qu'une commande en a besoin.</p>
      <ul class="liste">
        <li v-for="f in fichiers" :key="f.id">
          <span>{{ f.nom }}</span>
          <small class="discret">supprimé le {{ date(f.expire_le) }}</small>
          <button class="icone" aria-label="supprimer" title="supprimer" @click="supprimerFichier(f)">✕</button>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.titre-ligne { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.coche { flex: none !important; display: flex; align-items: center; }
.coche input { width: 18px; height: 18px; margin: 0; accent-color: var(--accent); }
.coche.inactive { opacity: .35; }
.commander { align-self: flex-start; margin-top: 10px; }
</style>
