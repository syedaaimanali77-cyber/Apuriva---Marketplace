'use client';

import { useEffect } from 'react';

/**
 * Spec 044 §3.2 (AC-1) — registers `public/sw.js` (scope `/`) in production builds only; it never runs in
 * `next dev`. `updateViaCache: 'none'` makes the browser re-fetch `sw.js` and its imported `sw-rules.js`
 * past the HTTP cache, so every deploy's worker is picked up. Renders nothing.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(() => console.info(JSON.stringify({ event: 'pwa.sw_registered' })))
      .catch((err: unknown) => console.warn(JSON.stringify({ event: 'pwa.sw_registration_failed', error: String(err) })));
  }, []);
  return null;
}
