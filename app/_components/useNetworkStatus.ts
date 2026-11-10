'use client';

import { useSyncExternalStore } from 'react';

/**
 * Spec 044 §3.3 — whether the browser believes it is online (`navigator.onLine` and the `online`/`offline`
 * events). Advisory only: `navigator.onLine` can read true without internet access, so a rejected `fetch`
 * (`NETWORK_ERROR`) stays the authoritative per-request signal (R-3). The server render assumes online.
 */
function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

export function useNetworkStatus(): { online: boolean } {
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  return { online };
}
