// Service worker de la PWA admin : rend l'application installable et garde ses fichiers pour un
// démarrage rapide. L'API (/api/...) n'est JAMAIS mise en cache : état des machines, commandes et
// sessions viennent toujours du serveur.
const VERSION = 'admin-v7';
const FICHIERS = [
  'index.html', 'suivi.html', 'galerie.html', 'boutique.html', 'bon.html', 'profil.html', 'connexion.html',
  'style.css', 'config.js', 'commun.js', 'machine.js', 'filament.js', 'app.js', 'suivi.js', 'galerie.js',
  'boutique.js', 'bon.js', 'profil.js', 'connexion.js', 'apercu3d.js', 'apercu-stl.js',
  'vendor/three/three.module.min.js', 'vendor/three/OrbitControls.js', 'vendor/three/STLLoader.js',
  'manifest.webmanifest', 'icones/icone.svg', 'icones/icone-192.png', 'icones/icone-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((cles) => Promise.all(cles.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// réseau d'abord (toujours la dernière version), copie locale si le réseau ne répond pas
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(fetch(e.request).then((rep) => {
    if (rep.ok && rep.type === 'basic') {
      const copie = rep.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copie));
    }
    return rep;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
