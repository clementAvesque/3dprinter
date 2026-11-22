<script setup>
// Achat d'un ou plusieurs devis (commande groupée : /commande/3,5,7) : adresse de livraison, puis paiement sur la
// page sécurisée de Stripe. Le montant (une seule livraison sur le poids total) est calculé par le serveur :
// le navigateur n'envoie que les numéros de devis et l'adresse.
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';

const route = useRoute();
const ids = computed(() => String(route.params.id).split(',').filter(Boolean));          // UUID des devis
const estimation = ref(null), adresses = ref([]), choisie = ref(null), erreur = ref(''), occupe = ref(false);
const nouvelle = ref({ nom_complet: '', ligne1: '', ligne2: '', code_postal: '', ville: '', telephone: '' });
const ajout = ref(false);

const euros = (cts) => (cts == null ? '—' : `${(cts / 100).toFixed(2).replace('.', ',')} €`);
const gr = (g) => `${Math.round(g * 10) / 10}`.replace('.', ',');
const groupee = computed(() => ids.value.length > 1);

async function charger() {
  try {
    [estimation.value, adresses.value] = await Promise.all([
      api('GET', `/commandes/estimation?devis=${ids.value.join(',')}`), api('GET', '/adresses')]);
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
    const { url } = await api('POST', '/commandes', { devis_ids: ids.value, adresse_id: choisie.value });
    window.location.assign(url);          // page de paiement Stripe
  } catch (e) {
    erreur.value = e.message;
    occupe.value = false;
  }
}
</script>

<template>
  <main class="page-texte">
    <h1>{{ groupee ? `Commander ${ids.length} devis ensemble` : `Commander le devis ${estimation?.devis[0]?.ref || ''}` }}</h1>
    <p v-if="erreur" class="erreur" role="alert">{{ erreur }}</p>
    <p v-if="erreur && !estimation">
      <RouterLink :to="groupee ? '/compte' : `/devis/${ids[0]}`" class="lien">Retour</RouterLink>
    </p>

    <template v-if="estimation">
      <section v-if="groupee" class="carte">
        <h2>Devis de la commande</h2>
        <ul class="liste">
          <li v-for="d in estimation.devis" :key="d.id">
            <RouterLink :to="`/devis/${d.id}`" class="lien">Devis {{ d.ref }}</RouterLink>
            <small class="discret">{{ d.pieces.length }} fichier(s) · {{ gr(d.poids_g) }} g</small>
            <b>{{ euros(d.prix_matiere_cts) }}</b>
          </li>
        </ul>
      </section>

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
        <div><span>Matière ({{ gr(estimation.poids_g) }} g de PLA)</span><b>{{ euros(estimation.sous_total_cts) }}</b></div>
        <div><span>{{ groupee ? 'Livraison (un seul colis)' : 'Livraison' }}</span><b>{{ euros(estimation.livraison_cts) }}</b></div>
        <p v-if="estimation.economie_livraison_cts > 0" class="economie">
          Un seul colis pour tes {{ ids.length }} devis : {{ euros(estimation.economie_livraison_cts) }} de livraison en moins.</p>
        <div class="total"><span>Total</span><b>{{ euros(estimation.total_cts) }}</b></div>
        <button class="primaire" :disabled="occupe || !choisie || ajout" @click="payer">Payer {{ euros(estimation.total_cts) }}</button>
        <small class="discret">Paiement sécurisé par Stripe : tes coordonnées bancaires ne passent jamais par notre site.
          Nous vérifions chaque commande sous 10 jours ; si nous ne pouvons pas l'imprimer, tu es remboursé intégralement.</small>
      </section>
      <RouterLink :to="groupee ? '/compte' : `/devis/${ids[0]}`" class="lien">Retour</RouterLink>
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
.economie { margin: 0; color: var(--ok); font-size: 14px; }
</style>
