import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// ---------------------------------------------------------------------------
// The production build and development server share one config.
// ---------------------------------------------------------------------------
// 1. Development: `npm run dev` on port 5173, calling the Node API on 4000.
// 2. Production: the frontend is built into the Node app image and served from
//    the web root. VITE_BASE_PATH can be changed for a subpath deployment.
//
// In dev the proxy below means the frontend can call '/api/...' relative, the
// same string it uses in production. Without it you need two different API base
// URLs and a conditional, which is the usual source of "works in dev, 404s in
// the build".
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_DEV_API_TARGET || 'http://localhost:4000';

  return {
    plugins: [svelte()],

    base: env.VITE_BASE_PATH || '/',

    server: {
      port: 5173,
      strictPort: true, // fail loudly rather than silently moving to 5174
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        // ws: true is what makes Socket.io work through the dev proxy; without
        // it the handshake succeeds over polling and then the upgrade fails.
        '/socket.io': { target: apiTarget, changeOrigin: true, ws: true },
      },
    },

    build: {
      outDir: 'dist',
      emptyOutDir: true,
      // Source maps make the bundle debuggable in the browser dev tools during
      // the demo, and cost nothing at runtime since they are only fetched when
      // dev tools are open.
      sourcemap: true,
      rollupOptions: {
        output: {
          // Split the socket client out of the app bundle: it changes far less
          // often than the app code, so a returning PWA user re-downloads only
          // what actually changed.
          manualChunks: {
            realtime: ['socket.io-client'],
          },
        },
      },
    },
  };
});
