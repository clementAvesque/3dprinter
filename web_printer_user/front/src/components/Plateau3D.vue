<script setup>
// Plateau de l'imprimante en 3D avec les pièces rangées dessus (three.js, rendu à la demande).
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const props = defineProps({
  plateau: { type: Array, default: () => [250, 250, 260] },     // [x, y, z] en mm
  pieces: { type: Array, default: () => [] },                    // [{ id, geometrie, dims }]
  places: { type: Array, default: () => [] },                    // [{ id, n, x, y, rot }]
  hors: { type: Array, default: () => [] },                      // [{ id, n }]
});

const conteneur = ref(null);
let renderer, scene, camera, controls, groupePlateau, groupePieces, observateur, demande = false;
const couleurs = ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#84cc16'];
const css = (n, d) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;

function rendu() {
  if (demande) return;
  demande = true;
  requestAnimationFrame(() => {
    demande = false;
    const encore = controls.update();
    renderer.render(scene, camera);
    if (encore) rendu();
  });
}

function construirePlateau() {
  scene.remove(groupePlateau);
  groupePlateau = new THREE.Group();
  const [L, H] = props.plateau;
  const plaque = new THREE.Mesh(new THREE.BoxGeometry(L, H, 2),
    new THREE.MeshStandardMaterial({ color: css('--plateau', '#2a2f3a'), roughness: 0.9 }));
  plaque.position.set(L / 2, H / 2, -1);
  const grille = new THREE.GridHelper(Math.max(L, H), Math.max(L, H) / 10, css('--grille', '#3a4150'), css('--grille', '#3a4150'));
  grille.rotation.x = Math.PI / 2;
  grille.position.set(L / 2, H / 2, 0.05);
  groupePlateau.add(plaque, grille);
  scene.add(groupePlateau);
}

function construirePieces() {
  scene.remove(groupePieces);
  groupePieces = new THREE.Group();
  const index = new Map(props.pieces.map((p, i) => [p.id, { ...p, couleur: couleurs[i % couleurs.length] }]));
  const materiaux = new Map();
  const mat = (c) => {
    if (!materiaux.has(c)) materiaux.set(c, new THREE.MeshStandardMaterial({ color: c, roughness: 0.55, metalness: 0.05 }));
    return materiaux.get(c);
  };
  for (const pl of props.places) {
    const p = index.get(pl.id);
    if (!p) continue;
    const m = new THREE.Mesh(p.geometrie, mat(p.couleur));
    m.position.set(pl.x, pl.y, 0);
    m.rotation.z = (pl.rot * Math.PI) / 180;
    groupePieces.add(m);
  }
  // pièces qui ne rentrent pas : posées à côté du plateau, en rouge
  let x = props.plateau[0] + 20;
  for (const h of props.hors) {
    const p = index.get(h.id);
    if (!p) continue;
    const m = new THREE.Mesh(p.geometrie, mat('#ef4444'));
    m.position.set(x + p.dims[0] / 2, props.plateau[1] / 2, 0);
    x += p.dims[0] + 10;
    groupePieces.add(m);
  }
  scene.add(groupePieces);
  rendu();
}

function cadrer() {
  const [L, H, Z] = props.plateau;
  const d = Math.max(L, H) * 1.45;
  controls.target.set(L / 2, H / 2, Math.min(Z, 60) / 2);
  camera.position.set(L / 2 + d * 0.55, H / 2 - d * 0.9, d * 0.75);
  controls.update();
  rendu();
}

function redimensionner() {
  const l = conteneur.value.clientWidth, h = conteneur.value.clientHeight;
  if (!l || !h) return;
  renderer.setSize(l, h);
  camera.aspect = l / h;
  camera.updateProjectionMatrix();
  rendu();
}

onMounted(() => {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  conteneur.value.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 1, 10000);
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight('#ffffff', '#555566', 1.6));
  const soleil = new THREE.DirectionalLight('#ffffff', 1.4);
  soleil.position.set(200, -150, 400);
  scene.add(soleil);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.addEventListener('change', rendu);
  construirePlateau();
  construirePieces();
  observateur = new ResizeObserver(redimensionner);
  observateur.observe(conteneur.value);
  redimensionner();
  cadrer();
});

onBeforeUnmount(() => {
  observateur?.disconnect();
  controls?.dispose();
  renderer?.dispose();
});

watch(() => props.plateau.join('x'), () => { construirePlateau(); cadrer(); construirePieces(); });
watch(() => [props.places, props.hors, props.pieces], construirePieces, { deep: true });
defineExpose({ cadrer });
</script>

<template>
  <div ref="conteneur" class="plateau3d" aria-label="Aperçu 3D du plateau de l'imprimante"></div>
</template>

<style scoped>
.plateau3d { position: absolute; inset: 0; }
.plateau3d :deep(canvas) { display: block; touch-action: none; }
</style>
