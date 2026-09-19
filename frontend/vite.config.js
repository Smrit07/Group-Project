import { defineConfig, loadEnv } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// ---------------------------------------------------------------------------
// Two deployment shapes have to work from one config.
// ---------------------------------------------------------------------------
// 1. Development: `npm run dev` on port 5173, calling the Node API on 4000.
// 2. XAMPP: `npm run build`, output copied into C:/xampp/htdocs/smart-cafeteria,
//    served by Apache on port 80, which reverse-proxies /api and /socket.io
//    through to Node.
//
// The thing that breaks shape 2 is `base`. Vite defaults to '/', so every asset
// is requested from http://localhost/assets/... — which is the wrong folder
// when the app lives in a htdocs subdirectory. Setting VITE_BASE_PATH to
// '/smart-cafeteria/' makes the built index.html reference its own folder.
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
