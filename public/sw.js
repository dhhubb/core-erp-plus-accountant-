/**
 * Branch till service worker.
 *
 * A branch runs the till as an installed PWA on the shop LAN, with no internet. The service worker
 * exists so the till shell loads from cache when the LAN server is briefly unreachable, and so the
 * app can be installed to the home screen.
 *
 * It is deliberately conservative:
 *   - Only GET requests to same-origin *pages and static assets* are cached.
 *   - Any request under /api/ is never cached: a sale must reach the server (or fail into the
 *     IndexedDB outbox, which the app handles), never be served from a stale cache.
 *   - A navigation falls back to the cached till shell, so a reload during a blip still renders.
 */

const CACHE = 'erp-branch-v1';
const SHELL = ['/pos', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache the API. The outbox is the offline path, not a stale response.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/pos').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
