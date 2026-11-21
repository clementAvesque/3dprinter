import { defineStore } from 'pinia';
import { api, poserCsrf } from '../api.js';

// compte du client connecté (null si personne)
export const useSession = defineStore('session', {
  state: () => ({ client: null, charge: false }),
  actions: {
    async charger() {
      try {
        const r = await api('GET', '/moi');
        poserCsrf(r.csrf);
        this.client = r.client;
      } catch {
        this.client = null;
      }
      this.charge = true;
    },
    ouvrir(r) {
      poserCsrf(r.csrf);
      this.client = r.client;
      this.charge = true;
    },
    async connexion(email, motdepasse) {
      this.ouvrir(await api('POST', '/connexion', { email, motdepasse }));
    },
    async deconnexion() {
      await api('POST', '/deconnexion', {}).catch(() => {});
      poserCsrf('');
      this.client = null;
    },
  },
});
