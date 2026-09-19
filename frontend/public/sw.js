// ---------------------------------------------------------------------------
// Service worker — PWA app-shell caching (NFR-01, NFR-09).
// ---------------------------------------------------------------------------
// Two rules, and the second one is the important one:
//
//   * Static assets: cache-first. They are content-hashed by Vite, so a cached
//     copy is never stale — a changed file gets a different filename.
//   * Everything under /api and /socket.io: never cached, ever. The entire
//     value of this app is that the queue number is current. A service worker
//     serving a four-hour-old wait estimate from cache would be worse than no
//     app at all, and it is exactly the mistake a naive cache-everything
//     handler makes.
//
// Navigation requests use network-first with a cached fallback, so the shell
// still opens on a dropped connection (showing "live queue unavailable")
// rather than the browser's offline dinosaur.

const VERSION = 'v2';
const SHELL_CACHE = `smart-cafeteria-shell-${VERSION}`;
const ASSET_CACHE = `smart-cafeteria-assets-${VERSION}`;

// Scope-relative, not absolute. The app may be served from a htdocs
// subdirectory (/smart-cafeteria/), where an absolute '/' would cache the
// wrong page — or fail to cache at all and silently disable offline support.
const SCOPE = new URL(self.registration.scope).pathname;
const APP_SHELL = [SCOPE, `${SCOPE}index.html`, `${SCOPE}manifest.webmanifest`];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // addAll rejects the whole batch if any single request 404s, which would
      // leave the worker uninstalled with no clue why. Individual puts let the
      // rest succeed.
      .then((cache) => Promise.allSettled(APP_SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !keep.has(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GET is cacheable. A cached POST would mean an order placed twice.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never intercept the API, the socket, or another origin.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/') || url.pathname.includes('/socket.io/')) return;

  // Navigations: network-first, so a deploy reaches the user immediately.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(`${SCOPE}index.html`, copy));
          return response;
        })
        .catch(() =>
          caches.match(`${SCOPE}index.html`).then((cached) => cached || Response.error())
        )
    );
    return;
  }

  // Static assets: cache-first, filling the cache as they are first requested.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Only cache successful same-origin responses; caching an error page
        // under an asset URL makes the app permanently broken until the user
        // clears site data.
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(ASSET_CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});

// Lets the page trigger an immediate update instead of waiting for every tab
// to close, which is what "reload to get the new version" needs behind it.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
