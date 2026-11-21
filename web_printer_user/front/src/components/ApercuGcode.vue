<script setup>
// Aperçu 3D, couche par couche, du gcode découpé par le serveur (OrcaSlicer) pour un devis.
// Données : /api/client/devis/:id/trajets (couches) et /trajets-bin (segments), format décrit dans
// serveur/src/trajets.js. Le gcode lui-même n'est jamais envoyé au navigateur.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const props = defineProps({
  devisId: { type: [Number, String], required: true },
  plateau: { type: Array, default: () => [250, 250] },        // [x, y] en mm
});

// une couleur par type de trajet (même ordre que TYPES dans serveur/src/trajets.js)
const COULEURS = ['#fb923c', '#facc15', '#c084fc', '#f472b6', '#f87171', '#4ade80', '#2dd4bf', '#94a3b8'];

const conteneur = ref(null);
const etat = ref('chargement');            // chargement | pret | erreur
const meta = ref(null);
const couche = ref(0);
const vueActive = ref('iso');
const nbCouches = computed(() => meta.value?.layers.length || 0);
const hauteur = computed(() => meta.value?.layers[couche.value]?.[0] ?? 0);
// types réellement présents dans ce gcode (légende)
const legende = ref([]);

let renderer, scene, camera, controls, observateur, fait, enCours, reste, demande = false;
const css = (n, d) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d;

function rendu() {
  if (demande || !renderer) return;
  demande = true;
  requestAnimationFrame(() => {
    demande = false;
    const encore = controls.update();
    renderer.render(scene, camera);
    if (encore) rendu();
  });
}

function redimensionner() {
  const l = conteneur.value?.clientWidth, h = conteneur.value?.clientHeight;
  if (!l || !h) return;
  renderer.setSize(l, h);
  camera.aspect = l / h;
  camera.updateProjectionMatrix();
  rendu();
}

function vue(nom) {
  vueActive.value = nom;
  const b = meta.value?.bbox;
  const [L, H] = props.plateau;
  const c = b ? new THREE.Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2) : new THREE.Vector3(L / 2, H / 2, 0);
  const taille = b ? Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2], 30) : L;
  const dirs = { iso: [0.75, -1, 0.8], dessus: [0, -0.001, 1], face: [0, -1, 0.12] };
  const dir = new THREE.Vector3(...(dirs[nom] || dirs.iso)).normalize();
  controls.target.copy(c);
  camera.position.copy(c).addScaledVector(dir, taille * 2.1);
  controls.update();
  rendu();
}

// couches 0..i : déjà faites atténuées, la couche i en pleine couleur, le reste en fantôme
function afficherJusqua(i) {
  if (!meta.value) return;
  const L = meta.value.layers;
  const [, debut, nb] = L[Math.max(0, Math.min(L.length - 1, i))];
  fait.geometry.setDrawRange(0, debut * 2);
  enCours.geometry.setDrawRange(debut * 2, nb * 2);
  reste.geometry.setDrawRange((debut + nb) * 2, (meta.value.segments - debut - nb) * 2);
  rendu();
}

async function charger() {
  const base = `/api/client/devis/${encodeURIComponent(props.devisId)}`;
  const [rm, rb] = await Promise.all([fetch(`${base}/trajets`, { credentials: 'same-origin' }),
    fetch(`${base}/trajets-bin`, { credentials: 'same-origin' })]);
  if (!rm.ok || !rb.ok) throw new Error('aperçu indisponible');
  const m = await rm.json();
  const bin = await rb.arrayBuffer();
  const n = m.segments;
  const c = new Int16Array(bin, 0, n * 4);
  const types = new Uint8Array(bin, n * 8, n);

  const pos = new Float32Array(n * 6);
  const col = new Uint8Array(n * 6);
  const palette = COULEURS.map((h) => new THREE.Color(h));
  const presents = new Set();
  m.layers.forEach(([z, debut, nb], i) => {
    const f = i % 2 ? 0.82 : 1;                 // une couche sur deux un peu plus sombre : couches lisibles
    for (let s = debut; s < debut + nb; s++) {
      const p = s * 6, q = s * 4;
      pos[p] = c[q] / 100; pos[p + 1] = c[q + 1] / 100; pos[p + 2] = z;
      pos[p + 3] = c[q + 2] / 100; pos[p + 4] = c[q + 3] / 100; pos[p + 5] = z;
      const k = palette[types[s]] || palette[palette.length - 1];
      presents.add(types[s]);
      col[p] = col[p + 3] = k.r * f * 255; col[p + 1] = col[p + 4] = k.g * f * 255; col[p + 2] = col[p + 5] = k.b * f * 255;
    }
  });

  const aPos = new THREE.BufferAttribute(pos, 3);
  const aCol = new THREE.BufferAttribute(col, 3, true);
  const geo = () => { const g = new THREE.BufferGeometry(); g.setAttribute('position', aPos); g.setAttribute('color', aCol); return g; };
  fait = new THREE.LineSegments(geo(), new THREE.LineBasicMaterial({ vertexColors: true, color: 0xb0b0b0 }));
  enCours = new THREE.LineSegments(geo(), new THREE.LineBasicMaterial({ vertexColors: true }));
  reste = new THREE.LineSegments(geo(), new THREE.LineBasicMaterial({ color: css('--discret', '#9aa1ad'), transparent: true, opacity: 0.12, depthWrite: false }));
  for (const o of [fait, enCours, reste]) { o.frustumCulled = false; scene.add(o); }

  meta.value = m;
  legende.value = [...presents].sort().map((t) => ({ nom: m.types[t], couleur: COULEURS[t] || COULEURS[COULEURS.length - 1] }));
  couche.value = m.layers.length - 1;
  afficherJusqua(couche.value);
  vue('iso');
}

function construireScene() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  conteneur.value.appendChild(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 1, 10000);
  camera.up.set(0, 0, 1);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.addEventListener('change', rendu);

  const [L, H] = props.plateau;
  const plaque = new THREE.Mesh(new THREE.PlaneGeometry(L, H), new THREE.MeshBasicMaterial({ color: css('--plateau', '#2a2f3a') }));
  plaque.position.set(L / 2, H / 2, -0.05);
  const grille = new THREE.GridHelper(Math.max(L, H), Math.max(L, H) / 10, css('--grille', '#3a4150'), css('--grille', '#3a4150'));
  grille.rotation.x = Math.PI / 2;
  grille.position.set(L / 2, H / 2, 0);
  scene.add(plaque, grille);

  observateur = new ResizeObserver(redimensionner);
  observateur.observe(conteneur.value);
  redimensionner();
  vue('iso');
}

onMounted(async () => {
  construireScene();
  try {
    await charger();
    etat.value = 'pret';
  } catch {
    etat.value = 'erreur';
  }
});

onBeforeUnmount(() => {
  observateur?.disconnect();
  for (const o of [fait, enCours, reste]) { o?.geometry.dispose(); o?.material.dispose(); }
  controls?.dispose();
  renderer?.dispose();
});

const mm = (v) => `${Math.round(v * 100) / 100}`.replace('.', ',');
</script>

<template>
  <div class="apercu">
    <div class="vue">
      <div ref="conteneur" class="canvas" aria-label="Aperçu 3D de l'impression, couche par couche"></div>
      <p v-if="etat === 'chargement'" class="message">Chargement de l'aperçu…</p>
      <p v-else-if="etat === 'erreur'" class="message erreur">L'aperçu n'a pas pu être chargé.</p>
      <div v-if="etat === 'pret'" class="vues" role="group" aria-label="Angle de vue">
        <button v-for="v in [['iso', '3D'], ['dessus', 'Dessus'], ['face', 'Face']]" :key="v[0]" type="button"
                :class="{ actif: vueActive === v[0] }" @click="vue(v[0])">{{ v[1] }}</button>
      </div>
    </div>
    <template v-if="etat === 'pret'">
      <label class="curseur">
        <span>Couche <b>{{ couche + 1 }}</b> / {{ nbCouches }} · {{ mm(hauteur) }} mm</span>
        <input v-model.number="couche" type="range" min="0" :max="nbCouches - 1" step="1"
               aria-label="Couche affichée" @input="afficherJusqua(couche)">
      </label>
      <ul class="legende">
        <li v-for="l in legende" :key="l.nom"><i :style="{ background: l.couleur }"></i>{{ l.nom }}</li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.apercu { display: flex; flex-direction: column; gap: 12px; }
.vue { position: relative; height: 420px; border-radius: 10px; overflow: hidden; background: var(--fond-vue); }
.canvas { position: absolute; inset: 0; }
.canvas :deep(canvas) { display: block; touch-action: none; }
.message { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--discret); }
.vues { position: absolute; top: 10px; right: 10px; display: flex; gap: 4px; }
.vues button { padding: 4px 10px; font-size: 13px; border-radius: 6px; border: 1px solid var(--bord); background: var(--fond-carte); color: var(--texte); cursor: pointer; }
.vues button.actif { background: var(--accent); border-color: var(--accent); color: var(--accent-texte); }
.curseur { display: flex; flex-direction: column; gap: 6px; font-size: 14px; color: var(--discret); }
.curseur b { color: var(--texte); }
.curseur input { width: 100%; accent-color: var(--accent); }
.legende { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 0; padding: 0; list-style: none; font-size: 13px; color: var(--discret); }
.legende i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }
@media (max-width: 600px) { .vue { height: 320px; } }
</style>
