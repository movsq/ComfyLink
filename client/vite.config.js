import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ mode }) => {
  // Load the root .env (one level up from client/) so PORT is available here.
  // The '' prefix means all vars are loaded, not just VITE_ ones.
  const env = loadEnv(mode, '../', '');
  const PORT = parseInt(env.PORT || '3000', 10);

  return {
    plugins: [svelte()],

    // Tell Vite to look for .env files in the project root instead of client/.
    envDir: '../',

    build: {
      outDir: 'dist',
    },

    server: {
      // Proxy API and WebSocket calls to the local Node.js server in dev mode.
      // In production (VPS), Caddy handles this routing instead.
      proxy: {
        '/auth': `http://localhost:${PORT}`,
        '/pc-pubkey': `http://localhost:${PORT}`,
        '/health': `http://localhost:${PORT}`,
        '/ws': {
          target: `ws://localhost:${PORT}`,
          ws: true,
        },
      },
    },
  };
});
