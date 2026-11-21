<script setup>
// CGV, mentions légales, confidentialité : pages vides pour l'instant (contenu à rédiger et faire valider).
defineProps({ titre: { type: String, required: true } });
</script>

<template>
  <main class="page-texte">
    <h1>{{ titre }}</h1>
    <p class="discret">Cette page est en cours de rédaction.</p>
  </main>
</template>
