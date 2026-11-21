import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { routeur } from './router.js';
import { useSession } from './stores/session.js';
import './style.css';

const app = createApp(App).use(createPinia()).use(routeur);

// pages réservées aux clients connectés : retour à la connexion, puis à la page demandée
routeur.beforeEach(async (vers) => {
  if (!vers.meta.connecte) return true;
  const session = useSession();
  if (!session.charge) await session.charger();
  return session.client ? true : { path: '/connexion', query: { suite: vers.fullPath } };
});

app.mount('#app');
