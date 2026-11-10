/**
 * Spec 007 §4 (AuthGate resume-state safety) — the client-side record `AuthGate` carries across
 * a guest's signup/login redirect so it can resume the exact in-progress action afterward. This
 * module owns the storage, validation, expiry, and anti-open-redirect rules; it deliberately
 * knows nothing about any specific feature's action shape — later domain specs supply their own
 * `actionType` and JSON-serializable `payload`.
 *
 * Never persisted server-side (spec 007 §4 retention) and never allowed to carry a secret — see
 * `assertNoSensitiveKeys` below.
 */

const STORAGE_KEY = 'apuriva_authgate_resume';
const RESUME_STATE_VERSION = 1;

/** Bounded lifetime (spec 007 §4): a resume attempt older than this is discarded, not resumed. */
export const RESUME_STATE_TTL_MS = 15 * 60 * 1000;

/** Bounded size (spec 007 §4): resume state is for a small UI-state pointer, not a data cache. */
export const RESUME_STATE_MAX_BYTES = 4096;

/** Shallow, case-insensitive denylist — defense in depth against a caller accidentally passing
 * something secret-shaped into `payload`, on top of the "never store secrets" contract itself. */
const SENSITIVE_KEY_PATTERN = /password|passwd|otp|token|secret|credential|card(number)?|cvv|cvc|pin\b/i;

export interface ResumeState {
  version: 1;
  /** In-app path to return the guest to after successful authentication. Must be a safe,
   * same-origin relative path — see `isSafeInAppPath`. */
  returnTo: string;
  /** Caller-defined label for which action is being resumed, e.g. "save-provider". */
  actionType: string;
  /** Non-sensitive, JSON-serializable data needed to replay the action — never a secret. */
  payload: Record<string, unknown>;
  savedAt: number;
  expiresAt: number;
}

export interface SaveResumeStateInput {
  returnTo: string;
  actionType: string;
  payload?: Record<string, unknown>;
}

function assertNoSensitiveKeys(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new Error(
        `AuthGate resume state must never carry sensitive data; refusing to store key "${key}".`,
      );
    }
  }
}

/**
 * Rejects anything but an in-app, same-origin relative path — the one thing standing between
 * "resume where the guest left off" and an open-redirect. `returnTo` is never treated as a full
 * URL: absolute URLs, protocol-relative ("//host/..."), and any embedded scheme are all rejected.
 */
export function isSafeInAppPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.startsWith('/\\')) return false;
  if (value.includes('://')) return false;
  if (value.includes('\0')) return false;
  return true;
}

function isStorageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.sessionStorage !== 'undefined';
}

/** Validates the full shape of a value read back from storage — never trust it implicitly. */
export function isValidResumeState(value: unknown): value is ResumeState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== RESUME_STATE_VERSION) return false;
  if (!isSafeInAppPath(v.returnTo)) return false;
  if (typeof v.actionType !== 'string' || v.actionType.length === 0) return false;
  if (typeof v.payload !== 'object' || v.payload === null || Array.isArray(v.payload)) return false;
  if (typeof v.savedAt !== 'number' || typeof v.expiresAt !== 'number') return false;
  if (v.expiresAt <= v.savedAt) return false;
  return true;
}

function isExpired(state: ResumeState, now: number): boolean {
  return now >= state.expiresAt;
}

/**
 * Saves the guest's in-progress action so it can be resumed after authentication succeeds.
 * Throws if `returnTo` isn't a safe in-app path, if `payload` looks like it carries a secret, or
 * if the serialized record exceeds the size bound — callers get an immediate, loud failure
 * rather than a silently-broken resume.
 */
export function saveResumeState(input: SaveResumeStateInput): void {
  if (!isSafeInAppPath(input.returnTo)) {
    throw new Error(`AuthGate resume state requires a safe in-app returnTo path, got: ${String(input.returnTo)}`);
  }
  const payload = input.payload ?? {};
  assertNoSensitiveKeys(payload);

  const savedAt = Date.now();
  const state: ResumeState = {
    version: RESUME_STATE_VERSION,
    returnTo: input.returnTo,
    actionType: input.actionType,
    payload,
    savedAt,
    expiresAt: savedAt + RESUME_STATE_TTL_MS,
  };

  const serialized = JSON.stringify(state);
  if (new TextEncoder().encode(serialized).length > RESUME_STATE_MAX_BYTES) {
    throw new Error('AuthGate resume state exceeds the maximum allowed size.');
  }

  if (!isStorageAvailable()) return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Best-effort — if storage is unavailable/full, the guest simply isn't resumed post-auth;
    // they still land on the app successfully authenticated.
  }
}

/** Reads a pending resume state without consuming it. Returns `null` if absent, malformed, or
 * expired (an expired entry is opportunistically cleared). */
export function peekResumeState(): ResumeState | null {
  if (!isStorageAvailable()) return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearResumeState();
    return null;
  }

  if (!isValidResumeState(parsed)) {
    clearResumeState();
    return null;
  }
  if (isExpired(parsed, Date.now())) {
    clearResumeState();
    return null;
  }
  return parsed;
}

/** Reads and clears a pending resume state in one step — use this to actually resume (single
 * use: a resume attempt is consumed whether or not the caller ends up replaying the action). */
export function consumeResumeState(): ResumeState | null {
  const state = peekResumeState();
  clearResumeState();
  return state;
}

export function clearResumeState(): void {
  if (!isStorageAvailable()) return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing else to do.
  }
}
