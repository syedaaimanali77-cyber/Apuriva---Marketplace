/**
 * Spec 018 §3 "Timing rules" — the 2-minute offer window.
 *
 * Master spec §32: exactly 2 minutes, decided by the server/database; the browser timer is
 * cosmetic. **Not configurable** — not an admin setting, a feature flag or an env var. The database
 * enforces the same value independently (`offers_two_minute_window_ck`: `expires_at = sent_at +
 * interval '2 minutes'`), so changing only this file cannot change the real window.
 */
import { sql } from 'drizzle-orm';
import type { OfferStatus, VisibleOfferStatus } from '@/lib/types/offers';

/** The window in milliseconds — for display arithmetic and tests only, never for a decision. */
export const OFFER_WINDOW_MS = 120_000;

/** The SQL literal every write uses; kept beside the constant it corresponds to. */
export const OFFER_WINDOW_SQL = sql.raw(`interval '2 minutes'`);

/** Stored statuses that are still awaiting the customer's decision (subject to `expires_at`). */
export const PENDING_OFFER_STATUSES = ['sent', 'viewed'] as const;

export function isPendingStatus(status: string): boolean {
  return (PENDING_OFFER_STATUSES as readonly string[]).includes(status);
}

/**
 * Live = pending stored status AND the clock strictly before `expires_at`. The boundary is
 * exclusive: at exactly `expires_at` the offer is expired.
 */
export function isLiveAt(storedStatus: string, expiresAt: Date | null, now: Date): boolean {
  return isPendingStatus(storedStatus) && expiresAt !== null && now.getTime() < expiresAt.getTime();
}

/**
 * The status a reader sees (AC-3): a pending row past `expires_at` reads as `expired` even before the
 * sweep persists it. `now` must be the DATABASE clock read in the same query as the row.
 */
export function effectiveStatus(storedStatus: OfferStatus, expiresAt: Date | null, now: Date): VisibleOfferStatus {
  if (isPendingStatus(storedStatus) && !isLiveAt(storedStatus, expiresAt, now)) return 'expired';
  return storedStatus as VisibleOfferStatus;
}

/**
 * Spec 018 §5 cosmetic countdown: `max(0, ceil((expiresAt − serverNow) / 1000) − elapsedSinceFetch)`.
 * `elapsedSinceFetchMs` comes from the browser's monotonic clock, so a wrong device clock can neither
 * lengthen nor shorten the display. Never gates an action.
 */
export function countdownSecondsRemaining(expiresAt: string, serverNow: string, elapsedSinceFetchMs: number): number {
  const remainingAtFetch = Math.ceil((Date.parse(expiresAt) - Date.parse(serverNow)) / 1000);
  const elapsed = Math.floor(Math.max(0, elapsedSinceFetchMs) / 1000);
  return Math.max(0, remainingAtFetch - elapsed);
}
