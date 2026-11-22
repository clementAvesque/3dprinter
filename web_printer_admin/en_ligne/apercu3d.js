// Aperçu 3D d'un gcode, couche par couche, avec la buse (three.js).
//
//   const vue = new Apercu3D(document.getElementById("vue"), (nom) => `${API}/machines/kobra-1/files/${nom}`);
//   const meta = await vue.charger("piece.gcode");      // couches lues par <base>/toolpath
//   vue.afficherJusqua(12);                            // couches 0..12 (la 12 en pleine couleur)
//   vue.placerBuse(120, 98, 2.6);
//
// Les segments viennent de <base>/toolpath-bin (format décrit dans client_printer/toolpath.py).
// three.js est copié dans vendor/ : la CSP du site n'autorise que ses propres scripts.

import * as THREE from "./vendor/three/three.module.min.js";
import { OrbitControls } from "./vendor/three/OrbitControls.js";

// une couleur par type de trajet (même ordre que toolpath.TYPES)
export const COULEURS_TYPES = [
  "#fb923c",  // paroi externe
  "#facc15",  // paroi interne
  "#c084fc",  // remplissage
  "#f472b6",  // remplissage plein
  "#f87171",  // surface dessus/dessous
  "#4ade80",  // support
  "#2dd4bf",  // jupe / bordure
  "#94a3b8",  // autre
];

const PLATEAU = 250;          // Kobra 3 : plateau 250 x 250 mm
const HAUTEUR_BUSE = 10;

const css = (nom) => getComputedStyle(document.documentElement).getPropertyValue(nom).trim();
const cheminUrl = (nom) => nom.split("/").map(encodeURIComponent).join("/");

export class Apercu3D {
  // base(nom) : adresse du fichier sur l'API ; /toolpath et /toolpath-bin y sont ajoutés
  constructor(conteneur, base) {
    this.el = conteneur;
    this.base = base;
    this.meta = null;
    this.nom = null;
    this.coords = null;             // Int16Array : x1, y1, x2, y2 (centièmes de mm) par segment
    this._suivi = { couche: -1, seg: 0 };
    this._demande = false;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.el.prepend(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    this.camera.up.set(0, 0, 1);    // Z vers le haut, comme l'imprimante

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener("change", () => this.demanderRendu());

    // plateau + grille de 10 mm
    this.plateau = new THREE.Mesh(
      new THREE.PlaneGeometry(PLATEAU, PLATEAU),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55 }),
    );
    this.plateau.position.set(PLATEAU / 2, PLATEAU / 2, -0.05);
    this.grille = new THREE.GridHelper(PLATEAU, PLATEAU / 10);
    this.grille.rotation.x = Math.PI / 2;
    this.grille.position.set(PLATEAU / 2, PLATEAU / 2, 0);
    this.scene.add(this.plateau, this.grille);

    // buse : cône pointe en bas + petit tube au-dessus
    const matBuse = new THREE.MeshBasicMaterial({ color: css("--accent") || "#3b82f6" });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.6, 6, 24), matBuse);
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = 3;
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, HAUTEUR_BUSE, 16), matBuse);
    tube.rotation.x = Math.PI / 2;
    tube.position.z = 6 + HAUTEUR_BUSE / 2;
    this.buse = new THREE.Group();
    this.buse.add(cone, tube);
    this.buse.visible = false;
    this.buseCible = null;
    this.scene.add(this.buse);

    this.appliquerTheme();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.appliquerTheme());

    this._ro = new ResizeObserver(() => this.redimensionner());
    this._ro.observe(this.el);
    this.redimensionner();
    this.vue("iso");
  }

  appliquerTheme() {
    this.scene.background = new THREE.Color(css("--card") || "#1a1d23");
    this.plateau.material.color.set(css("--input") || "#23272e");
    const bord = new THREE.Color(css("--border") || "#2b2f37");
    this.grille.material.color = bord;
    this.grille.material.vertexColors = false;
    this.grille.material.needsUpdate = true;
    this.demanderRendu();
  }

  redimensionner() {
    const l = this.el.clientWidth, h = this.el.clientHeight;
    if (!l || !h) return;
    this.renderer.setSize(l, h);
    this.camera.aspect = l / h;
    this.camera.updateProjectionMatrix();
    this.demanderRendu();
  }

  // ---------------------------------------------------------------- chargement

  async charger(nom) {
    // le premier appel peut être long : l'agent lit le gcode sur la machine puis l'envoie (gardé en cache ensuite)
    const base = this.base(cheminUrl(nom));
    // no-cache : copie du navigateur revalidée auprès du serveur (un même nom peut désigner un autre gcode)
    const options = { credentials: window.API_BASE ? "include" : "same-origin", cache: "no-cache" };
    const metaRep = await fetch(`${base}/toolpath`, options);
    const meta = await metaRep.json().catch(() => ({}));
    if (!metaRep.ok) throw new Error(texteErreur(meta));
    const binRep = await fetch(`${base}/toolpath-bin`, options);
    if (!binRep.ok) throw new Error(texteErreur(await binRep.json().catch(() => ({}))));
    const bin = await binRep.arrayBuffer();

    const n = meta.segments;
    // en-tête et segments doivent venir du même gcode : 9 octets par segment
    if (!Number.isInteger(n) || bin.byteLength !== n * 9) {
      throw new Error(`aperçu incohérent (${n} trajets annoncés, ${bin.byteLength} octets reçus) : recharge la page`);
    }
    const c = new Int16Array(bin, 0, n * 4);
    const types = new Uint8Array(bin, n * 8, n);

    // positions (2 sommets par segment) et couleurs ; une couche sur deux un peu plus sombre
    // pour bien voir les couches
    const pos = new Float32Array(n * 6);
    const col = new Uint8Array(n * 6);
    const palette = COULEURS_TYPES.map((h) => new THREE.Color(h));
    meta.layers.forEach(([z, debut, nb], i) => {
      const f = i % 2 ? 0.82 : 1;
      for (let s = debut; s < debut + nb; s++) {
        const p = s * 6, q = s * 4;
        pos[p] = c[q] / 100; pos[p + 1] = c[q + 1] / 100; pos[p + 2] = z;
        pos[p + 3] = c[q + 2] / 100; pos[p + 4] = c[q + 3] / 100; pos[p + 5] = z;
        const k = palette[types[s]] || palette[palette.length - 1];
        const r = k.r * f * 255, g = k.g * f * 255, b = k.b * f * 255;
        col[p] = col[p + 3] = r; col[p + 1] = col[p + 4] = g; col[p + 2] = col[p + 5] = b;
      }
    });

    this.vider();
    const aPos = new THREE.BufferAttribute(pos, 3);
    const aCol = new THREE.BufferAttribute(col, 3, true);
    // trois vues des mêmes données (les attributs sont partagés, envoyés une seule fois au GPU) :
    // couches déjà faites (un peu atténuées), couche en cours (pleine couleur), reste (fantôme)
    const geo = () => { const g = new THREE.BufferGeometry(); g.setAttribute("position", aPos); g.setAttribute("color", aCol); return g; };
    this.fait = new THREE.LineSegments(geo(), new THREE.LineBasicMaterial({ vertexColors: true, color: 0xa6a6a6 }));
    this.couche = new THREE.LineSegments(geo(), new THREE.LineBasicMaterial({ vertexColors: true }));
    this.reste = new THREE.LineSegments(geo(), new THREE.LineBasicMaterial({
      color: css("--muted") || "#9aa0a8", transparent: true, opacity: 0.12, depthWrite: false,
    }));
    for (const o of [this.fait, this.couche, this.reste]) {
      o.frustumCulled = false;
      this.scene.add(o);
    }

    this.meta = meta;
    this.nom = nom;
    this.coords = c;
    this._suivi = { couche: -1, seg: 0 };
    this.afficherJusqua(meta.layers.length - 1);
    this.cadrer();
    return meta;
  }

  vider() {
    for (const o of [this.fait, this.couche, this.reste]) {
      if (!o) continue;
      this.scene.remove(o);
      o.geometry.dispose();
      o.material.dispose();
    }
    this.fait = this.couche = this.reste = null;
    this.meta = this.nom = this.coords = null;
    this.demanderRendu();
  }

  get nbCouches() {
    return this.meta ? this.meta.layers.length : 0;
  }

  // ---------------------------------------------------------------- affichage

  // couches 0..i visibles ; la couche i en pleine couleur, coupée au segment `segFin` (exclu)
  // si on sait où en est la buse ; tout ce qui reste à imprimer en fantôme
  afficherJusqua(i, segFin = null) {
    if (!this.meta) return;
    const L = this.meta.layers;
    i = Math.max(0, Math.min(L.length - 1, i));
    const [, debut, nb] = L[i];
    const fin = segFin == null ? debut + nb : Math.max(debut, Math.min(debut + nb, segFin));
    this.fait.geometry.setDrawRange(0, debut * 2);
    this.couche.geometry.setDrawRange(debut * 2, (fin - debut) * 2);
    this.reste.geometry.setDrawRange(fin * 2, (this.meta.segments - fin) * 2);
    this.demanderRendu();
  }

  // segment de la couche i le plus proche de la buse (x, y) -> index de fin pour afficherJusqua.
  // n'avance que vers l'avant (la buse repasse souvent au-dessus de trajets déjà faits)
  progressionParBuse(i, x, y) {
    if (!this.meta || x == null || y == null) return null;
    const [, debut, nb] = this.meta.layers[Math.max(0, Math.min(this.nbCouches - 1, i))];
    if (this._suivi.couche !== i) this._suivi = { couche: i, seg: debut };
    const c = this.coords, X = x * 100, Y = y * 100, fin = debut + nb;
    const chercher = (a, b) => {
      let best = -1, dmin = Infinity;
      for (let s = a; s < b; s++) {
        const dx = c[s * 4 + 2] - X, dy = c[s * 4 + 3] - Y, d = dx * dx + dy * dy;
        if (d < dmin) { dmin = d; best = s; }
      }
      return [best, Math.sqrt(dmin) / 100];
    };
    let [s, d] = chercher(this._suivi.seg, fin);
    if (d > 2) [s, d] = chercher(debut, fin);
    if (s >= 0 && d <= 2 && s + 1 > this._suivi.seg) this._suivi.seg = s + 1;
    return this._suivi.seg;
  }

  // dernière couche dont la hauteur est <= z (si le nombre de couches ne correspond pas au firmware)
  coucheDeZ(z) {
    if (!this.meta || z == null) return 0;
    let i = 0;
    for (let k = 0; k < this.meta.layers.length; k++) {
      if (this.meta.layers[k][0] <= z + 0.02) i = k;
      else break;
    }
    return i;
  }

  placerBuse(x, y, z) {
    if (x == null || y == null || z == null) {
      this.buse.visible = false;
      this.demanderRendu();
      return;
    }
    const cible = new THREE.Vector3(x, y, z);
    if (!this.buse.visible) this.buse.position.copy(cible);
    this.buseCible = cible;
    this.buse.visible = true;
    this.demanderRendu();
  }

  // ---------------------------------------------------------------- caméra

  _centre() {
    const b = this.meta && this.meta.bbox;
    if (!b) return { c: new THREE.Vector3(PLATEAU / 2, PLATEAU / 2, 0), taille: PLATEAU };
    const c = new THREE.Vector3((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2);
    return { c, taille: Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2], 30) };
  }

  cadrer() {
    this.vue(this._vue || "iso");
  }

  vue(nom) {
    this._vue = nom;
    const { c, taille } = this._centre();
    const d = taille * 2.1;
    const dirs = {
      iso: new THREE.Vector3(0.75, -1, 0.8),
      dessus: new THREE.Vector3(0, -0.001, 1),
      face: new THREE.Vector3(0, -1, 0.12),
    };
    const dir = (dirs[nom] || dirs.iso).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, d);
    this.controls.update();
    this.demanderRendu();
  }

  // ---------------------------------------------------------------- rendu

  // rendu à la demande (pas de boucle continue : la carte graphique reste au repos)
  demanderRendu() {
    if (this._demande) return;
    this._demande = true;
    requestAnimationFrame(() => {
      this._demande = false;
      let encore = this.controls.update();      // inertie de la rotation
      if (this.buseCible && this.buse.visible) {
        this.buse.position.lerp(this.buseCible, 0.15);
        if (this.buse.position.distanceTo(this.buseCible) > 0.05) encore = true;
        else this.buse.position.copy(this.buseCible);
      }
      this.renderer.render(this.scene, this.camera);
      if (encore) this.demanderRendu();
    });
  }

  detruire() {
    this._ro.disconnect();
    this.vider();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
