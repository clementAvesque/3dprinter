<script setup>
import { onMounted } from 'vue';
import { useSession } from './stores/session.js';

const session = useSession();
onMounted(() => session.charger());
</script>

<template>
  <header class="entete">
    <RouterLink to="/" class="marque">
      <img src="/favicon.svg" alt="" width="28" height="28">
      <span>Impression 3D</span>
    </RouterLink>
    <nav>
      <RouterLink v-if="session.client" to="/compte">Mes commandes</RouterLink>
      <RouterLink v-else-if="session.charge" to="/connexion">Se connecter</RouterLink>
    </nav>
    <div id="actions-entete" class="actions-entete"></div>
  </header>
  <RouterView />
  <footer class="pied">
    <RouterLink to="/cgv">CGV</RouterLink>
    <RouterLink to="/mentions-legales">Mentions légales</RouterLink>
    <RouterLink to="/confidentialite">Confidentialité</RouterLink>
  </footer>
</template>
