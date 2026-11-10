/*
 * Spec 044 §3.2 (D-1) — the service worker's caching rules, as pure functions. A classic script: `sw.js`
 * loads it with `importScripts('/sw-rules.js')`, and lib/pwa/sw-rules.test.ts evaluates this exact file in a
 * `node:vm` sandbox. It assigns `self.apurivaSwRules`.
 *
 * What is cached, and nothing else:
 *   static   — GET /_next/static/** (content-hashed, immutable): cache-first.
 *   image    — GET /images/** (public marketing images): stale-while-revalidate.
 *   icon     — GET /icons/* : served from the offline cache, filled at install.
 *   navigate — network-only; on a network failure the cached guest-rendered /offline page.
 * Never: any non-GET (not intercepted at all), anything under /api/, another origin, the manifest,
 * robots.txt, sitemap.xml, and every other HTML or data response.
 */
(function (scope) {
  'use strict';

  var CACHE_PREFIX = 'apuriva-';
  var OFFLINE_URL = '/offline';
  var ICON_URLS = ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png'];

  function cacheNames(version) {
    return {
      static: CACHE_PREFIX + 'static-v' + version,
      images: CACHE_PREFIX + 'images-v' + version,
      offline: CACHE_PREFIX + 'offline-v' + version,
    };
  }

  /** Every `apuriva-*` cache that is not one of this version's (deleted on activate). */
  function staleCaches(existing, version) {
    var current = cacheNames(version);
    var keep = [current.static, current.images, current.offline];
    return existing.filter(function (name) {
      return name.indexOf(CACHE_PREFIX) === 0 && keep.indexOf(name) === -1;
    });
  }

  /**
   * How the worker treats a request: 'static' | 'image' | 'icon' | 'navigate' | 'none'.
   * 'none' means the worker does not call respondWith — the browser handles it exactly as without a worker.
   */
  function classify(request, origin) {
    if (request.method !== 'GET') return 'none';
    var url;
    try {
      url = new URL(request.url);
    } catch {
      return 'none';
    }
    if (url.origin !== origin) return 'none';
    var path = url.pathname;
    if (path === '/api' || path.indexOf('/api/') === 0) return 'none';
    if (request.mode === 'navigate') return 'navigate';
    if (path.indexOf('/_next/static/') === 0) return 'static';
    if (path.indexOf('/images/') === 0) return 'image';
    if (ICON_URLS.indexOf(path) !== -1) return 'icon';
    return 'none';
  }

  /** The same-origin `/_next/static/**` files an HTML document references (the offline page's own assets). */
  function staticAssetsIn(html) {
    var found = {};
    // Stops at a backslash too: Next's inline RSC payload quotes asset paths as \"/_next/static/...\".
    var re = /["'(](\/_next\/static\/[^"'()\s>\\]+)/g;
    var match;
    while ((match = re.exec(html)) !== null) found[match[1]] = true;
    return Object.keys(found);
  }

  scope.apurivaSwRules = {
    CACHE_PREFIX: CACHE_PREFIX,
    OFFLINE_URL: OFFLINE_URL,
    ICON_URLS: ICON_URLS,
    cacheNames: cacheNames,
    staleCaches: staleCaches,
    classify: classify,
    staticAssetsIn: staticAssetsIn,
  };
})(self);
