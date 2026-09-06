/**
 * Spec 007 §4/§8 (resolved): onboarding "seen/skipped" state lives in durable client-side
 * browser storage only (`localStorage`), keyed to the device/browser — never a `User` database
 * column. It remains effective after the guest later signs up/logs in on the same device; no
 * server round-trip is involved in reading or writing it.
 */
const STORAGE_KEY = 'apuriva_onboarding_seen';

function isStorageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function hasSeenOnboarding(): boolean {
  if (!isStorageAvailable()) return true; // SSR/no-storage: never show, don't ever block render
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Storage can throw (Safari private mode, disabled cookies, quota) — treat as already seen
    // so a storage failure never re-shows the intro on every navigation.
    return true;
  }
}

export function markOnboardingSeen(): void {
  if (!isStorageAvailable()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Best-effort — nothing else to do if storage is unavailable/full.
  }
}
