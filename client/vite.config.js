import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ mode }) => {
  // Load the root .env (one level up from client/) so PORT is available here.
  // The '' prefix means all vars are loaded, not just VITE_ ones.
  const env = loadEnv(mode, '../', '');
  const PORT = parseInt(env.PORT || '3000', 10);

  // A missing VITE_GOOGLE_CLIENT_ID is not a build error — Login.svelte treats it
  // as an email-only deployment and skips GSI entirely. That makes a half-configured
  // .env fail silently: the build succeeds and ships a login page with no Google
  // button. Only the *inconsistent* case is unambiguously wrong, so fail on that.
  if (env.GOOGLE_CLIENT_ID && !env.VITE_GOOGLE_CLIENT_ID) {
    throw new Error(
      'GOOGLE_CLIENT_ID is set but VITE_GOOGLE_CLIENT_ID is not. The client build ' +
      'inlines the latter at build time; without it the Google sign-in button never ' +
      'renders. Set both to the same value in the repo-root .env.'
    );
  }

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
        '/config': `http://localhost:${PORT}`,
        '/tos': `http://localhost:${PORT}`,
        '/pc-pubkey': `http://localhost:${PORT}`,
        '/codes': `http://localhost:${PORT}`,
        '/health': `http://localhost:${PORT}`,
        '/vault': `http://localhost:${PORT}`,
        '/results': `http://localhost:${PORT}`,
        '/admin': `http://localhost:${PORT}`,
        '/ws': {
          target: `ws://localhost:${PORT}`,
          ws: true,
        },
      },
    },
  };
});
