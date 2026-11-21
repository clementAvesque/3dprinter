import { createRouter, createWebHistory } from 'vue-router';
import Atelier from './pages/Atelier.vue';

// les pages hors atelier sont chargées à la demande
export const routeur = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'atelier', component: Atelier },
    { path: '/connexion', name: 'connexion', component: () => import('./pages/Connexion.vue') },
    { path: '/inscription', name: 'inscription', component: () => import('./pages/Inscription.vue') },
    { path: '/verifier', name: 'verifier', component: () => import('./pages/Verifier.vue') },
    { path: '/mot-de-passe-oublie', name: 'oubli', component: () => import('./pages/MotDePasseOublie.vue') },
    { path: '/reinitialiser', name: 'reinitialiser', component: () => import('./pages/Reinitialiser.vue') },
    { path: '/compte', name: 'compte', component: () => import('./pages/MonCompte.vue'), meta: { connecte: true } },
    { path: '/devis/:id', name: 'devis', component: () => import('./pages/Devis.vue'), meta: { connecte: true } },
    { path: '/commande/:id', name: 'achat', component: () => import('./pages/Achat.vue'), meta: { connecte: true } },
    { path: '/merci', name: 'merci', component: () => import('./pages/Merci.vue'), meta: { connecte: true } },
    { path: '/cgv', name: 'cgv', component: () => import('./pages/PageLegale.vue'), props: { titre: 'Conditions générales de vente' } },
    { path: '/mentions-legales', name: 'mentions', component: () => import('./pages/PageLegale.vue'), props: { titre: 'Mentions légales' } },
    { path: '/confidentialite', name: 'confidentialite', component: () => import('./pages/PageLegale.vue'), props: { titre: 'Confidentialité' } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
