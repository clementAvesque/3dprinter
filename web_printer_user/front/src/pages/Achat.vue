<script setup>
// Achat d'un devis : adresse de livraison, puis paiement sur la page sécurisée de Stripe.
// Le montant est celui du devis, calculé par le serveur : le navigateur n'envoie que le devis et l'adresse.
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';

const route = useRoute();
const devis = ref(null), adresses = ref([]), choisie = ref(null), erreur = ref(''), occupe = ref(false);
const nouvelle = ref({ nom_complet: '', ligne1: '', ligne2: '', code_postal: '', ville: '', telephone: '' });
const ajout = ref(false);

const euros = (cts) => (cts == null ? '—' : `${(cts / 100).toFixed(2).replace('.', ',')} €`);
const dejaPayee = computed(() => devis.value?.commande && !['en_attente_paiement', 'abandonnee'].includes(devis.value.commande.statut));

async function charger() {
  try {
    [devis.value, adresses.value] = await Promise.all([api('GET', `/devis/${encodeURIComponent(route.params.id)}`), api('GET', '/adresses')]);
    choisie.value = adresses.value[0]?.id ?? null;
    ajout.value = !adresses.value.length;
  } catch (e) {
    erreur.value = e.message;
  }
}
onMounted(charger);

async function ajouterAdresse() {
  erreur.value = '';
  occupe.value = true;
  try {
    const corps = Object.fromEntries(Object.entries(nouvelle.value).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    const { id } = await api('POST', '/adresses', corps);
    adresses.value = await api('GET', '/adresses');
    choisie.value = id;
    ajout.value = false;
  } catch (e) {
    erreur.value = e.message;
  } finally {
    occupe.value = false;
  }
}

async function payer() {
  erreur.value = '';
  occupe.value = true;
  try {
    const { url } = await api('POST', '/commandes', { devis_id: devis.value.id, adresse_id: choisie.value });
    window.location.assign(url);          // page de paiement Stripe
  } catch (e) {
    erreur.value = e.message;
    occupe.value = false;
  }
}
</script>

<template>
  <main class="page-texte">
    <p v-if="erreur" class="erreur" role="alert">{{ erreur }}</p>
    <template v-if="devis">
      <h1>Commander le devis n° {{ devis.id }}</h1>

      <div v-if="devis.statut !== 'pret'" class="carte">
        <p>Ce devis n'est pas encore prêt. <RouterLink :to="`/devis/${devis.id}`" class="lien">Retour au devis</RouterLink></p>
      </div>
      <div v-else-if="dejaPayee" class="carte">
        <p>Ce devis est déjà payé (commande n° {{ devis.commande.id }}). <RouterLink to="/compte" class="lien">Voir mes commandes</RouterLink></p>
      </div>

      <template v-else>
        <section class="carte">
          <h2>Adresse de livraison</h2>
          <ul v-if="adresses.length" class="liste">
            <li v-for="a in adresses" :key="a.id">
              <label class="choix">
                <input v-model="choisie" type="radio" name="adresse" :value="a.id">
                <span><b>{{ a.nom_complet }}</b><br>
                  <small class="discret">{{ a.ligne1 }}<template v-if="a.ligne2">, {{ a.ligne2 }}</template>, {{ a.code_postal }} {{ a.ville }}</small></span>
              </label>
            </li>
          </ul>
          <button v-if="!ajout" class="secondaire" type="button" @click="ajout = true">Ajouter une adresse</button>
          <form v-else class="formulaire" @submit.prevent="ajouterAdresse">
            <label>Nom et prénom<input v-model="nouvelle.nom_complet" required maxlength="100" autocomplete="name"></label>
            <label>Adresse<input v-model="nouvelle.ligne1" required maxlength="150" autocomplete="address-line1"></label>
            <label>Complément (facultatif)<input v-model="nouvelle.ligne2" maxlength="150" autocomplete="address-line2"></label>
            <div class="ligne">
              <label>Code postal<input v-model="nouvelle.code_postal" required maxlength="10" autocomplete="postal-code"></label>
              <label class="grand">Ville<input v-model="nouvelle.ville" required maxlength="80" autocomplete="address-level2"></label>
            </div>
            <label>Téléphone (facultatif, pour le transporteur)<input v-model="nouvelle.telephone" type="tel" maxlength="20" autocomplete="tel"></label>
            <small class="discret">Livraison en France uniquement pour l'instant.</small>
            <div class="ligne">
              <button class="primaire" :disabled="occupe">Enregistrer l'adresse</button>
              <button v-if="adresses.length" class="secondaire" type="button" @click="ajout = false">Annuler</button>
            </div>
          </form>
        </section>

        <section class="carte prix">
          <div><span>Matière ({{ devis.poids_g }} g de PLA)</span><b>{{ euros(devis.prix_matiere_cts) }}</b></div>
          <div><span>Livraison</span><b>{{ euros(devis.livraison_cts) }}</b></div>
          <div class="total"><span>Total</span><b>{{ euros(devis.total_cts) }}</b></div>
          <button class="primaire" :disabled="occupe || !choisie || ajout" @click="payer">Payer {{ euros(devis.total_cts) }}</button>
          <small class="discret">Paiement sécurisé par Stripe : tes coordonnées bancaires ne passent jamais par notre site.
            Nous vérifions chaque commande sous 10 jours ; si nous ne pouvons pas l'imprimer, tu es remboursé intégralement.</small>
        </section>
        <RouterLink :to="`/devis/${devis.id}`" class="lien">Retour au devis</RouterLink>
      </template>
    </template>
  </main>
</template>

<style scoped>
.choix { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
.choix input { width: auto; flex: none; margin: 4px 0 0; accent-color: var(--accent); }
.ligne { display: flex; gap: 10px; flex-wrap: wrap; }
.ligne label { flex: 1; min-width: 110px; }
.ligne .grand { flex: 2; }
.prix { display: flex; flex-direction: column; gap: 8px; }
.prix div { display: flex; justify-content: space-between; }
.prix .total { font-size: 18px; border-top: 1px solid var(--bord); padding-top: 8px; }
</style>
