/*
 * Spec 044 §3.2 (D-1) — APURIVA's service worker. Hand-written, no library. Registered by
 * app/_components/ServiceWorkerRegistrar.tsx in production builds only, scope "/".
 *
 * It caches only content-hashed static assets, public marketing images, the app icons and ONE
 * guest-rendered /offline page (fetched with credentials omitted, so it holds nothing private). It never
 * caches other HTML, never /api/, and never intercepts a non-GET request — writes go straight to the network
 * with their cookies, CSRF header and Idempotency-Key. Nothing is queued or replayed (D-2).
 * The rules themselves are public/sw-rules.js.
 *
 * VERSIONING: bump CACHE_VERSION whenever the caching logic changes. On activate every `apuriva-*` cache
 * that is not this version's is deleted; since HTML is never cached, a deploy never pairs an old page
 * with new assets or the reverse. Rolling back a deploy serves the previous sw.js, which likewise purges.
 *
 * EMERGENCY KILL SWITCH: replace this file's entire contents with
 *
 *   self.addEventListener('install', () => self.skipWaiting());
 *   self.addEventListener('activate', (event) => {
 *     event.waitUntil((async () => {
 *       for (const name of await caches.keys()) if (name.startsWith('apuriva-')) await caches.delete(name);
 *       await self.registration.unregister();
 *       for (const client of await self.clients.matchAll()) client.navigate(client.url);
 *     })());
 *   });
 *
 * and deploy. Browsers re-fetch sw.js bypassing the HTTP cache (updateViaCache: 'none'), so every client
 * picks it up on its next navigation, empties the caches and unregisters.
 */
const CACHE_VERSION = 1;

importScripts('/sw-rules.js');
const rules = self.apurivaSwRules;
const CACHES = rules.cacheNames(CACHE_VERSION);

async function precacheOffline() {
  const offline = await caches.open(CACHES.offline);
  const response = await fetch(rules.OFFLINE_URL, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`sw: /offline answered ${response.status}`);
  const html = await response.clone().text();
  await offline.put(rules.OFFLINE_URL, response);

  // The offline page's own scripts, styles and fonts, so it renders fully on a first offline launch.
  const assets = await caches.open(CACHES.static);
  await Promise.all(rules.staticAssetsIn(html).map((url) => assets.add(url).catch(() => undefined)));
  // Icons are design-supplied (spec 044 DEP-2); a missing one must not break installation.
  await Promise.all(rules.ICON_URLS.map((url) => offline.add(url).catch(() => undefined)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheOffline().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const stale = rules.staleCaches(await caches.keys(), CACHE_VERSION);
      await Promise.all(stale.map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok && response.type === 'basic') return cache.put(request, response.clone()).then(() => response);
      return response;
    })
    .catch(() => undefined);
  if (hit) return hit;
  const fresh = await refresh;
  return fresh ?? Response.error();
}

async function navigate(request) {
  try {
    // Network-only: HTML is never cached (only a network FAILURE falls back; an HTTP error page is shown as is).
    return await fetch(request);
  } catch {
    const offline = await caches.match(rules.OFFLINE_URL, { cacheName: CACHES.offline });
    return offline ?? Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const kind = rules.classify(event.request, self.location.origin);
  if (kind === 'none') return; // not intercepted: non-GET, /api/, other origins, all other responses
  if (kind === 'navigate') event.respondWith(navigate(event.request));
  else if (kind === 'static') event.respondWith(cacheFirst(event.request, CACHES.static));
  else if (kind === 'image') event.respondWith(staleWhileRevalidate(event.request, CACHES.images));
  else if (kind === 'icon') event.respondWith(cacheFirst(event.request, CACHES.offline));
});
