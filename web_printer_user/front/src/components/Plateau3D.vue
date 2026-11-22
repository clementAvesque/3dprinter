<script setup>
// Plateau de l'imprimante en 3D avec les pièces rangées dessus (three.js, rendu à la demande).
// Un clic sur une pièce la sélectionne (événement « choisir ») : elle s'éclaire, les autres s'estompent.
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { couleurPiece } from '../lib/couleurs.js';

const props = defineProps({
  plateau: { type: Array, default: () => [250, 250, 260] },     // [x, y, z] en mm
  pieces: { type: Array, default: () => [] },                    // [{ id, geometrie, dims, echelle }]
  places: { type: Array, default: () => [] },                    // [{ id, n, x, y, rot }]
  hors: { type: Array, default: () => [] },                      // [{ id, n }]
  selection: { type: Number, default: null },                    // id de la pièce sélectionnée
});
const emit = defineEmits(['choisir']);

const conteneur = ref(null);
let renderer, scene, camera, controls, groupePlateau, groupePieces, observateur, demande = false;
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

// matériau selon la couleur de la pièce et la sélection (mis en cache : partagé par les exemplaires)
const materiaux = new Map();
function materiau(couleur, etat) {
  const cle = `${couleur}|${etat}`;
  if (!materiaux.has(cle)) {
    const m = new THREE.MeshStandardMaterial({ color: couleur, roughness: 0.55, metalness: 0.05 });
    if (etat === 'choisie') { m.emissive.set(couleur); m.emissiveIntensity = 0.45; }
    if (etat === 'estompee') { m.transparent = true; m.opacity = 0.35; m.depthWrite = false; }
    materiaux.set(cle, m);
  }
  return materiaux.get(cle);
}
const etatDe = (id) => (props.selection == null ? 'normale' : id === props.selection ? 'choisie' : 'estompee');

function construirePieces() {
  scene.remove(groupePieces);
  groupePieces = new THREE.Group();
  const index = new Map(props.pieces.map((p, i) => [p.id, { ...p, couleur: couleurPiece(i) }]));
  const placer = (p, couleur, x, y, rot) => {
    const m = new THREE.Mesh(p.geometrie, materiau(couleur, etatDe(p.id)));
    m.scale.setScalar(p.echelle || 1);           // multiplicateur de taille (STL en mètres, en cm...)
    m.position.set(x, y, 0);
    m.rotation.z = (rot * Math.PI) / 180;
    m.userData.id = p.id;
    groupePieces.add(m);
  };
  for (const pl of props.places) {
    const p = index.get(pl.id);
    if (p) placer(p, p.couleur, pl.x, pl.y, pl.rot);
  }
  // pièces qui ne rentrent pas : posées à côté du plateau, en rouge
  let x = props.plateau[0] + 20;
  for (const h of props.hors) {
    const p = index.get(h.id);
    if (!p) continue;
    placer(p, '#ef4444', x + p.dims[0] / 2, props.plateau[1] / 2, 0);
    x += p.dims[0] + 10;
  }
  scene.add(groupePieces);
  rendu();
}

// clic (pas un glissé pour tourner la vue) : pièce sous le curseur, ou rien (désélection)
const raycaster = new THREE.Raycaster();
let appui = null;
function surAppui(e) { appui = { x: e.clientX, y: e.clientY }; }
function surRelache(e) {
  if (!appui || Math.hypot(e.clientX - appui.x, e.clientY - appui.y) > 5) { appui = null; return; }
  appui = null;
  const r = renderer.domElement.getBoundingClientRect();
  const souris = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(souris, camera);
  const touche = raycaster.intersectObjects(groupePieces?.children || [], false)[0];
  emit('choisir', touche ? touche.object.userData.id : null);
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
  renderer.domElement.addEventListener('pointerdown', surAppui);
  renderer.domElement.addEventListener('pointerup', surRelache);
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
  renderer?.domElement.removeEventListener('pointerdown', surAppui);
  renderer?.domElement.removeEventListener('pointerup', surRelache);
  for (const m of materiaux.values()) m.dispose();
  controls?.dispose();
  renderer?.dispose();
});

watch(() => props.plateau.join('x'), () => { construirePlateau(); cadrer(); construirePieces(); });
watch(() => [props.places, props.hors, props.pieces, props.selection], construirePieces, { deep: true });
defineExpose({ cadrer });
</script>

<template>
  <div ref="conteneur" class="plateau3d" aria-label="Aperçu 3D du plateau de l'imprimante : clique sur une pièce pour l'identifier"></div>
</template>

<style scoped>
.plateau3d { position: absolute; inset: 0; }
.plateau3d :deep(canvas) { display: block; touch-action: none; cursor: pointer; }
</style>
