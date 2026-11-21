import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// En développement, /api est relayé vers le serveur (par défaut celui qui tourne sur ce PC, port 3000).
// En production, le site est servi par le serveur lui-même : même adresse, aucun relais.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: process.env.API || 'http://127.0.0.1:3000', changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
