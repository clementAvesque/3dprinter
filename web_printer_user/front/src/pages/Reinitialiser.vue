<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSession } from '../stores/session.js';
import { api } from '../api.js';

const route = useRoute();
const routeur = useRouter();
const session = useSession();
const motdepasse = ref(''), confirmation = ref(''), erreur = ref(''), occupe = ref(false);

async function envoyer() {
  erreur.value = '';
  if (motdepasse.value !== confirmation.value) { erreur.value = 'Les deux mots de passe ne sont pas identiques.'; return; }
  occupe.value = true;
  try {
    session.ouvrir(await api('POST', '/mot-de-passe/reinitialiser', { jeton: String(route.query.jeton || ''), motdepasse: motdepasse.value }));
    routeur.push('/');
  } catch (e) {
    erreur.value = e.message;
  } finally {
    occupe.value = false;
  }
}
</script>

<template>
  <main class="page-etroite">
    <form class="carte formulaire" @submit.prevent="envoyer">
      <h1>Nouveau mot de passe</h1>
      <label>Nouveau mot de passe<input v-model="motdepasse" type="password" required minlength="12" maxlength="256" autocomplete="new-password"></label>
      <label>Encore une fois<input v-model="confirmation" type="password" required minlength="12" maxlength="256" autocomplete="new-password"></label>
      <small class="discret">12 caractères minimum. Tes autres sessions seront déconnectées.</small>
      <p v-if="erreur" class="erreur" role="alert">{{ erreur }}</p>
      <button class="primaire" :disabled="occupe">Enregistrer</button>
      <RouterLink v-if="erreur" to="/mot-de-passe-oublie" class="lien">Demander un nouveau lien</RouterLink>
    </form>
  </main>
</template>
