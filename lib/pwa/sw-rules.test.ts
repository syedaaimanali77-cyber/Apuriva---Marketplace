import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Spec 044 §3.2 (D-1, AC-3) — the service worker's caching rules, exercised on the EXACT shipped file:
 * public/sw-rules.js is evaluated in a sandbox `self`, as `importScripts` does in the worker.
 */
interface SwRules {
  CACHE_PREFIX: string;
  OFFLINE_URL: string;
  ICON_URLS: string[];
  cacheNames(version: number): { static: string; images: string; offline: string };
  staleCaches(existing: string[], version: number): string[];
  classify(request: { method: string; url: string; mode?: string }, origin: string): string;
  staticAssetsIn(html: string): string[];
}

function loadRules(): SwRules {
  const sandbox = { self: {} as { apurivaSwRules?: SwRules }, URL };
  const file = path.resolve(__dirname, '..', '..', 'public', 'sw-rules.js');
  // The real filename lets V8 coverage attribute the evaluated code to public/sw-rules.js (spec 044 §6: ≥80%).
  vm.runInNewContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
  return sandbox.self.apurivaSwRules!;
}

const rules = loadRules();
const ORIGIN = 'https://apuriva.example';
const get = (p: string, mode = 'no-cors') => ({ method: 'GET', url: `${ORIGIN}${p}`, mode });

describe('service worker caching rules (spec 044 §3.2)', () => {
  it('never intercepts a non-GET request, whatever its path', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const p of ['/api/v1/bookings', '/_next/static/x.js', '/images/a.jpg', '/bookings/1']) {
        expect(rules.classify({ method, url: `${ORIGIN}${p}`, mode: 'navigate' }, ORIGIN), `${method} ${p}`).toBe('none');
      }
    }
  });

  it('never touches /api/, other origins, or malformed URLs', () => {
    expect(rules.classify(get('/api/v1/users/me'), ORIGIN)).toBe('none');
    expect(rules.classify(get('/api'), ORIGIN)).toBe('none');
    expect(rules.classify(get('/api/v1/bookings', 'navigate'), ORIGIN)).toBe('none');
    expect(rules.classify({ method: 'GET', url: 'https://cdn.other.example/_next/static/a.js' }, ORIGIN)).toBe('none');
    expect(rules.classify({ method: 'GET', url: 'not a url' }, ORIGIN)).toBe('none');
  });

  it('treats page navigations as network-only (offline fallback), never cached', () => {
    for (const p of ['/', '/bookings/abc', '/account', '/explore?x=1']) expect(rules.classify(get(p, 'navigate'), ORIGIN), p).toBe('navigate');
  });

  it('caches only hashed static assets, public images and the app icons', () => {
    expect(rules.classify(get('/_next/static/chunks/app-abc123.js'), ORIGIN)).toBe('static');
    expect(rules.classify(get('/_next/static/css/1.css'), ORIGIN)).toBe('static');
    expect(rules.classify(get('/images/marketing/category-cleaning.jpg'), ORIGIN)).toBe('image');
    for (const icon of rules.ICON_URLS) expect(rules.classify(get(icon), ORIGIN), icon).toBe('icon');
  });

  it('does not cache HTML/data responses, the manifest, robots.txt or sitemap.xml', () => {
    for (const p of ['/manifest.webmanifest', '/robots.txt', '/sitemap.xml', '/sw.js', '/_next/image?url=x', '/bookings/1', '/icons/other.png', '/favicon.ico']) {
      expect(rules.classify(get(p), ORIGIN), p).toBe('none');
    }
  });

  it('versions its caches and marks every other apuriva-* cache stale (other caches untouched)', () => {
    expect(rules.cacheNames(3)).toEqual({ static: 'apuriva-static-v3', images: 'apuriva-images-v3', offline: 'apuriva-offline-v3' });
    expect(rules.staleCaches(['apuriva-static-v2', 'apuriva-static-v3', 'apuriva-images-v3', 'apuriva-offline-v1', 'apuriva-offline-v3', 'someone-else'], 3)).toEqual([
      'apuriva-static-v2',
      'apuriva-offline-v1',
    ]);
  });

  it('finds the offline page’s own /_next/static assets in its HTML, once each', () => {
    const html = `<link rel="stylesheet" href="/_next/static/css/a.css"/><script src="/_next/static/chunks/b.js" async></script>
      <link rel="preload" href="/_next/static/media/font.woff2" as="font"/><script src="/_next/static/chunks/b.js"></script>
      <img src="/images/x.jpg"/><script>self.__next_f.push([1,"\\"/_next/static/chunks/c.js\\""])</script>`;
    // Including one referenced only inside Next's escaped inline RSC payload; /images/ is not a static asset.
    expect(rules.staticAssetsIn(html).sort()).toEqual([
      '/_next/static/chunks/b.js',
      '/_next/static/chunks/c.js',
      '/_next/static/css/a.css',
      '/_next/static/media/font.woff2',
    ]);
    expect(rules.OFFLINE_URL).toBe('/offline');
  });
});
