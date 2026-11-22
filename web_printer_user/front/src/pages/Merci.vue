<script setup>
// Retour de Stripe après paiement. Le paiement n'est compté qu'à la confirmation de Stripe au serveur
// (webhook signé) : on attend que la commande passe « payée », quelques secondes en général.
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';

const route = useRoute();
const commande = ref(null), erreur = ref(''), attente = ref(true);
let minuteur = null, essais = 0;
const euros = (cts) => (cts == null ? '—' : `${(cts / 100).toFixed(2).replace('.', ',')} €`);

async function verifier() {
  try {
    commande.value = await api('GET', `/commandes/${encodeURIComponent(route.query.commande)}`);
    if (commande.value.statut === 'en_attente_paiement' && ++essais < 30) {
      minuteur = setTimeout(verifier, 2000);
      return;
    }
  } catch (e) {
    erreur.value = e.message;
  }
  attente.value = false;
}
onMounted(verifier);
onBeforeUnmount(() => clearTimeout(minuteur));
</script>

<template>
  <main class="page-texte">
    <p v-if="erreur" class="erreur">{{ erreur }}</p>
    <div v-else-if="attente" class="carte">
      <h1>Confirmation du paiement…</h1>
      <p class="discret">Stripe nous confirme ton paiement, ça prend quelques secondes.</p>
    </div>
    <template v-else-if="commande && commande.statut !== 'en_attente_paiement'">
      <div class="carte">
        <h1>Merci !</h1>
        <p>Ton paiement de <b>{{ euros(commande.total_cts) }}</b> est bien reçu : commande {{ commande.ref }}.</p>
        <p class="discret">Un e-mail de confirmation t'a été envoyé. Nous vérifions ta commande puis l'imprimons :
          expédition sous 2 semaines en général, 2 mois au plus. Tu seras prévenu à chaque étape.</p>
      </div>
      <RouterLink to="/compte" class="lien">Voir mes commandes</RouterLink>
    </template>
    <template v-else-if="commande">
      <div class="carte">
        <h1>Paiement pas encore confirmé</h1>
        <p class="discret">Stripe ne nous a pas encore confirmé le paiement de la commande {{ commande.ref }}. Si tu as bien payé,
          la confirmation arrivera par e-mail d'ici quelques minutes. Sinon, tu peux réessayer depuis ton devis.</p>
      </div>
      <RouterLink :to="`/devis/${commande.devis_id}`" class="lien">Retour au devis</RouterLink>
    </template>
  </main>
</template>
