<script setup>
// Connexion ou création de compte sans quitter l'atelier (les pièces déposées restent en place).
import { ref } from 'vue';
import { useSession } from '../stores/session.js';
import { api } from '../api.js';

defineProps({ ouvert: Boolean });
const emit = defineEmits(['fermer', 'connecte']);
const session = useSession();
const onglet = ref('connexion');
const email = ref(''), motdepasse = ref(''), nom = ref('');
const erreur = ref(''), message = ref(''), occupe = ref(false);

async function envoyer() {
  erreur.value = ''; message.value = ''; occupe.value = true;
  try {
    if (onglet.value === 'connexion') {
      await session.connexion(email.value.trim(), motdepasse.value);
      emit('connecte');
    } else {
      await api('POST', '/inscription', { email: email.value.trim(), motdepasse: motdepasse.value, nom: nom.value.trim() });
      message.value = 'Compte créé : ouvre le lien reçu par e-mail pour l\'activer, puis connecte-toi ici. Tes pièces restent en place.';
      onglet.value = 'connexion';
      motdepasse.value = '';
    }
  } catch (e) {
    erreur.value = e.message;
  } finally {
    occupe.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="ouvert" class="voile" @click.self="emit('fermer')">
      <form class="fenetre etroite" role="dialog" aria-modal="true" aria-labelledby="titre-compte" @submit.prevent="envoyer">
        <header>
          <h2 id="titre-compte">Connecte-toi pour envoyer tes pièces</h2>
          <button type="button" class="icone" aria-label="Fermer" @click="emit('fermer')">✕</button>
        </header>
        <div class="onglets" role="tablist">
          <button type="button" role="tab" :aria-selected="onglet === 'connexion'" :class="{ actif: onglet === 'connexion' }" @click="onglet = 'connexion'">J'ai un compte</button>
          <button type="button" role="tab" :aria-selected="onglet === 'inscription'" :class="{ actif: onglet === 'inscription' }" @click="onglet = 'inscription'">Créer un compte</button>
        </div>
        <p v-if="message" class="info">{{ message }}</p>
        <label v-if="onglet === 'inscription'">Prénom ou nom<input v-model="nom" required maxlength="80" autocomplete="name"></label>
        <label>E-mail<input v-model="email" type="email" required maxlength="254" autocomplete="email"></label>
        <label>Mot de passe<input v-model="motdepasse" type="password" required :minlength="onglet === 'inscription' ? 12 : 1" maxlength="256"
          :autocomplete="onglet === 'inscription' ? 'new-password' : 'current-password'"></label>
        <small v-if="onglet === 'inscription'" class="discret">12 caractères minimum.</small>
        <p v-if="erreur" class="erreur" role="alert">{{ erreur }}</p>
        <button class="primaire" :disabled="occupe">{{ onglet === 'connexion' ? 'Se connecter' : 'Créer mon compte' }}</button>
        <RouterLink v-if="onglet === 'connexion'" to="/mot-de-passe-oublie" class="lien" @click="emit('fermer')">Mot de passe oublié ?</RouterLink>
      </form>
    </div>
  </Teleport>
</template>
