<script setup>
// Mon compte : devis, commandes, fichiers gardés (et leur suppression), déconnexion.
import { onMounted, ref } from 'vue';
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
          <span>Commande n° {{ c.id }} · {{ date(c.cree_le) }}</span>
          <small class="discret">{{ STATUTS_COMMANDE[c.statut] }}<template v-if="c.numero_suivi"> · suivi {{ c.numero_suivi }}</template></small>
          <b>{{ euros(c.total_cts) }}</b>
        </li>
      </ul>
    </section>

    <section class="carte">
      <h2>Devis</h2>
      <p v-if="!devis.length" class="discret">Aucun devis. <RouterLink to="/" class="lien">Dépose tes STL dans l'atelier.</RouterLink></p>
      <ul class="liste">
        <li v-for="d in devis" :key="d.id">
          <RouterLink :to="`/devis/${d.id}`" class="lien">Devis n° {{ d.id }}</RouterLink>
          <small class="discret">{{ date(d.cree_le) }} · {{ d.pieces.length }} fichier(s) · {{ STATUTS_DEVIS[d.statut] }}</small>
        </li>
      </ul>
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
</style>
