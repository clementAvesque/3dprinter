<script setup>
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSession } from '../stores/session.js';
import { api } from '../api.js';

const session = useSession();
const route = useRoute();
const routeur = useRouter();
const email = ref(''), motdepasse = ref(''), erreur = ref(''), info = ref(''), occupe = ref(false), nonVerifie = ref(false);

async function envoyer() {
  erreur.value = ''; info.value = ''; nonVerifie.value = false; occupe.value = true;
  try {
    await session.connexion(email.value.trim(), motdepasse.value);
    const suite = String(route.query.suite || '/');
    routeur.push(suite.startsWith('/') && !suite.startsWith('//') ? suite : '/');
  } catch (e) {
    erreur.value = e.message;
    nonVerifie.value = e.code === 'email_non_verifie';
  } finally {
    occupe.value = false;
  }
}

async function renvoyer() {
  await api('POST', '/verification/renvoyer', { email: email.value.trim() }).catch(() => {});
  info.value = 'Si ce compte attend sa confirmation, un nouveau lien vient d\'être envoyé.';
}
</script>

<template>
  <main class="page-etroite">
    <form class="carte formulaire" @submit.prevent="envoyer">
      <h1>Connexion</h1>
      <label>E-mail<input v-model="email" type="email" required maxlength="254" autocomplete="email"></label>
      <label>Mot de passe<input v-model="motdepasse" type="password" required maxlength="256" autocomplete="current-password"></label>
      <p v-if="erreur" class="erreur" role="alert">{{ erreur }}</p>
      <button v-if="nonVerifie" type="button" class="secondaire" @click="renvoyer">Renvoyer le lien de confirmation</button>
      <p v-if="info" class="info">{{ info }}</p>
      <button class="primaire" :disabled="occupe">Se connecter</button>
      <div class="liens">
        <RouterLink to="/mot-de-passe-oublie" class="lien">Mot de passe oublié ?</RouterLink>
        <RouterLink to="/inscription" class="lien">Créer un compte</RouterLink>
      </div>
    </form>
  </main>
</template>
