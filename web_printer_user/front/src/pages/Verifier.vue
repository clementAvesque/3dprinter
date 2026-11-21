<script setup>
// Lien reçu par e-mail : confirme l'adresse et connecte directement.
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useSession } from '../stores/session.js';
import { api } from '../api.js';

const route = useRoute();
const session = useSession();
const etat = ref('attente'), erreur = ref('');

onMounted(async () => {
  try {
    session.ouvrir(await api('POST', '/verifier', { jeton: String(route.query.jeton || '') }));
    etat.value = 'ok';
  } catch (e) {
    erreur.value = e.message;
    etat.value = 'erreur';
  }
});
</script>

<template>
  <main class="page-etroite">
    <div class="carte formulaire">
      <h1>Confirmation de l'adresse</h1>
      <p v-if="etat === 'attente'">Vérification…</p>
      <template v-else-if="etat === 'ok'">
        <p class="info">C'est bon, ton compte est actif et tu es connecté.</p>
        <p class="discret">Si tes pièces sont dans un autre onglet, retournes-y et clique à nouveau sur « Découper ».</p>
        <RouterLink to="/" class="lien">Aller à l'atelier</RouterLink>
      </template>
      <template v-else>
        <p class="erreur">{{ erreur }}</p>
        <RouterLink to="/connexion" class="lien">Demander un nouveau lien depuis la connexion</RouterLink>
      </template>
    </div>
  </main>
</template>
