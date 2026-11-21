<script setup>
import { ref } from 'vue';
import { api } from '../api.js';

const nom = ref(''), email = ref(''), motdepasse = ref(''), erreur = ref(''), envoye = ref(false), occupe = ref(false);

async function envoyer() {
  erreur.value = ''; occupe.value = true;
  try {
    await api('POST', '/inscription', { email: email.value.trim(), motdepasse: motdepasse.value, nom: nom.value.trim() });
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
      <h1>Vérifie ta boîte mail</h1>
      <p>Nous avons envoyé un lien à <b>{{ email }}</b>. Ouvre-le pour activer ton compte (valable 48 h).</p>
      <p class="discret">Rien reçu ? Regarde dans les indésirables, ou réessaie depuis la page de connexion.</p>
      <RouterLink to="/" class="lien">Retour à l'atelier</RouterLink>
    </div>
    <form v-else class="carte formulaire" @submit.prevent="envoyer">
      <h1>Créer un compte</h1>
      <label>Prénom ou nom<input v-model="nom" required maxlength="80" autocomplete="name"></label>
      <label>E-mail<input v-model="email" type="email" required maxlength="254" autocomplete="email"></label>
      <label>Mot de passe<input v-model="motdepasse" type="password" required minlength="12" maxlength="256" autocomplete="new-password"></label>
      <small class="discret">12 caractères minimum.</small>
      <p v-if="erreur" class="erreur" role="alert">{{ erreur }}</p>
      <button class="primaire" :disabled="occupe">Créer mon compte</button>
      <RouterLink to="/connexion" class="lien">J'ai déjà un compte</RouterLink>
    </form>
  </main>
</template>
