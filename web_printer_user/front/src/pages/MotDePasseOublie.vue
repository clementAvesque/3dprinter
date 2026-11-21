<script setup>
import { ref } from 'vue';
import { api } from '../api.js';

const email = ref(''), envoye = ref(false), erreur = ref(''), occupe = ref(false);

async function envoyer() {
  erreur.value = ''; occupe.value = true;
  try {
    await api('POST', '/mot-de-passe/oubli', { email: email.value.trim() });
    envoye.value = true;
  } catch (e) {
    erreur.value = e.message;
  } finally {
    occupe.value = false;
  }
}
</script>

<template>
  <main class="page-etroite">
    <div v-if="envoye" class="carte formulaire">
      <h1>E-mail envoyé</h1>
      <p>Si un compte existe pour <b>{{ email }}</b>, tu vas recevoir un lien pour choisir un nouveau mot de passe.</p>
      <p class="discret">Ce lien ne marche qu'une fois et pendant 30 minutes.</p>
    </div>
    <form v-else class="carte formulaire" @submit.prevent="envoyer">
      <h1>Mot de passe oublié</h1>
      <p class="discret">Indique ton adresse : nous t'envoyons un lien éphémère pour en choisir un nouveau.</p>
      <label>E-mail<input v-model="email" type="email" required maxlength="254" autocomplete="email"></label>
      <p v-if="erreur" class="erreur" role="alert">{{ erreur }}</p>
      <button class="primaire" :disabled="occupe">Recevoir le lien</button>
      <RouterLink to="/connexion" class="lien">Retour à la connexion</RouterLink>
    </form>
  </main>
</template>
