// Aperçu 3D du STL d'une pièce, montré pendant qu'on survole une ligne de liste.
//
//   brancherApercuStl(ligne, `${API}/boutique/plaques/12/pieces/34/stl`, [20, 15, 8], 'obj_10_f126.stl');
//
// Les clients nomment mal leurs fichiers (« obj_10_f126插銷.stl ») : sur un plateau, seule la forme
// permet de reconnaître une pièce. Le modèle tourne lentement dans un panneau unique, en bas à gauche
// de l'écran : il est en position fixe, donc jamais rogné par les listes qui défilent (.plaque-liste et
// .plaque-corps ont overflow: auto), et tout son placement est dans style.css — aucun style en ligne (CSP).
//
// Une seule scène three.js pour toutes les lignes : un contexte WebGL par ligne, et le navigateur
// commence à fermer les plus anciens au bout d'une quinzaine. three.js est copié dans vendor/ (apercu3d.js).

import * as THREE from './vendor/three/three.module.min.js';
import { STLLoader } from './vendor/three/STLLoader.js';

const TAILLE = 160;                       // côté du canevas, en pixels CSS (voir .apercu-stl canvas)
const css = (nom) => getComputedStyle(document.documentElement).getPropertyValue(nom).trim();

let moteur = null;                        // scène partagée, créée au premier survol
let panneau = null;                       // le panneau d'aperçu, unique lui aussi
let actif = null;                         // jeton du survol en cours (une ligne qui n'est plus survolée n'affiche rien)
const geometries = new Map();             // url -> Promise<BufferGeometry> : un seul téléchargement par pièce

function creerPanneau() {
  const el = document.createElement('div');
  el.className = 'apercu-stl';
  el.hidden = true;
  const etat = document.createElement('p');
  etat.className = 'apercu-stl-etat';
  const nom = document.createElement('p');
  nom.className = 'apercu-stl-nom';
  const dims = document.createElement('p');
  dims.className = 'apercu-stl-dims';
  el.append(etat, nom, dims);
  document.body.append(el);
  panneau = { el, etat, nom, dims };
  return panneau;
}

function creerMoteur() {
  const rendu = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  rendu.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  rendu.setSize(TAILLE, TAILLE, false);   // false : pas de style en ligne sur le canevas
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
  scene.add(new THREE.AmbientLight(0xffffff, 1.6));
  const lampe = new THREE.DirectionalLight(0xffffff, 2.2);
  lampe.position.set(1, 2, 2);
  scene.add(lampe);
  const pivot = new THREE.Group();        // tourne lentement sur l'axe vertical
  const assiette = new THREE.Group();     // Z du STL vers le haut (three.js est en Y vers le haut)
  assiette.rotation.x = -Math.PI / 2;
  pivot.add(assiette);
  scene.add(pivot);
  moteur = { rendu, scene, camera, pivot, assiette, maille: null, anim: 0 };
  return moteur;
}

function poser(geometrie) {
  const m = moteur;
  if (m.maille) {
    m.assiette.remove(m.maille);
    m.maille.material.dispose();
  }
  const matiere = new THREE.MeshPhongMaterial({ color: css('--accent') || '#2563eb', shininess: 20, flatShading: true });
  m.maille = new THREE.Mesh(geometrie, matiere);
  // la géométrie est partagée entre les lignes : on ne la touche pas, on décale la maille pour la centrer
  const b = geometrie.boundingBox;
  m.maille.position.set(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -(b.min.z + b.max.z) / 2);
  m.assiette.add(m.maille);
  const rayon = geometrie.boundingSphere.radius || 1;
  const recul = (rayon / Math.tan((m.camera.fov * Math.PI) / 360)) * 1.35;
  m.camera.position.set(0, recul * 0.45, recul);
  m.camera.lookAt(0, 0, 0);
  m.pivot.rotation.y = 0;
}

function animer() {
  const m = moteur;
  m.anim = requestAnimationFrame(animer);
  m.pivot.rotation.y += 0.012;
  m.rendu.render(m.scene, m.camera);
}

function arreter() {
  if (!moteur?.anim) return;
  cancelAnimationFrame(moteur.anim);
  moteur.anim = 0;
}

// STL téléchargé et analysé une seule fois par pièce ; un échec n'est pas gardé en cache
function geometrie(url) {
  if (!geometries.has(url)) {
    geometries.set(url, (async () => {
      const rep = await fetch(url, { credentials: 'same-origin' });
      if (!rep.ok) throw new Error(String(rep.status));
      const g = new STLLoader().parse(await rep.arrayBuffer());
      g.computeBoundingBox();
      g.computeBoundingSphere();
      g.computeVertexNormals();
      return g;
    })().catch((e) => { geometries.delete(url); throw e; }));
  }
  return geometries.get(url);
}

// ligne : l'élément survolé ; dims : [x, y, z] en mm (facultatif) ; nom : nom du fichier du client
export function brancherApercuStl(ligne, url, dims, nom) {
  const jeton = {};
  const entrer = async () => {
    actif = jeton;
    const p = panneau || creerPanneau();
    // une pop-up modale est dans la « top layer » : un panneau laissé dans le body passerait dessous
    const hote = ligne.closest('dialog[open]') || document.body;
    if (p.el.parentNode !== hote) hote.append(p.el);
    p.el.hidden = false;
    p.nom.textContent = nom || '';
    p.dims.textContent = Array.isArray(dims) && dims.length === 3 ? `${dims[0]} × ${dims[1]} × ${dims[2]} mm` : '';
    p.etat.textContent = 'aperçu…';
    p.etat.hidden = false;
    moteur?.rendu.domElement.remove();   // sinon la pièce précédente resterait affichée pendant le chargement
    try {
      const g = await geometrie(url);
      if (actif !== jeton) return;                 // la souris est partie ailleurs pendant le chargement
      const m = moteur || creerMoteur();
      p.el.prepend(m.rendu.domElement);
      p.etat.hidden = true;
      poser(g);
      arreter();
      animer();
    } catch {
      if (actif === jeton) p.etat.textContent = 'aperçu impossible';
    }
  };
  const sortir = () => {
    if (actif !== jeton) return;
    actif = null;
    arreter();
    if (panneau) panneau.el.hidden = true;
  };
  ligne.addEventListener('mouseenter', entrer);
  ligne.addEventListener('mouseleave', sortir);
  ligne.addEventListener('focusin', entrer);       // même aperçu au clavier (Tab sur la case à cocher)
  ligne.addEventListener('focusout', sortir);
}
