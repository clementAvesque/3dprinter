<script setup>
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useSession } from './stores/session.js';

const session = useSession();
const route = useRoute();
// atelier : le plateau 3D occupe tout l'écran, les liens légaux sont dans son panneau
const atelier = computed(() => route.name === 'atelier');
onMounted(() => session.charger());
</script>

<template>
  <header class="entete" :class="{ flottante: atelier }">
    <RouterLink to="/" class="marque">
      <img src="/favicon.svg" alt="" width="28" height="28">
      <span>Impression 3D</span>
    </RouterLink>
    <!-- « Découper » (atelier) puis l'espace compte, à côté -->
    <div id="actions-entete" class="actions-entete"></div>
    <nav>
      <RouterLink v-if="session.client" to="/compte" class="bouton-compte" title="Mon espace compte">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <span>Mon compte</span>
      </RouterLink>
      <RouterLink v-else-if="session.charge" to="/connexion" class="bouton-compte">Se connecter</RouterLink>
    </nav>
  </header>
  <RouterView />
  <footer v-if="!atelier" class="pied">
    <RouterLink to="/cgv">CGV</RouterLink>
    <RouterLink to="/mentions-legales">Mentions légales</RouterLink>
    <RouterLink to="/confidentialite">Confidentialité</RouterLink>
  </footer>
</template>
