/**
 * Spec 025 §3 — the named constants of post-booking messaging. Fixed in code; the retention window is
 * the one server-side configuration value (`retention-config.ts`).
 */
import type { BookingStatus } from '@/lib/types/bookings';

/** Trimmed input bound, measured BEFORE redaction (§3 "Body bounds"). */
export const MESSAGE_BODY_MAX_LENGTH = 2000;
/** `messages_body_length_ck` — input bound plus headroom for placeholders and the sentinel. */
export const STORED_BODY_MAX_LENGTH = 2400;

/** §3 "Real-time transport" — the live-update interval while a conversation is active and visible. */
export const LIVE_UPDATE_INTERVAL_MS = 5_000;
/** How many messages one delta poll asks for. */
export const DELTA_READ_LIMIT = 50;
/** Exponential backoff ceiling for a failed poll. */
export const POLL_MAX_BACKOFF_MS = 30_000;

/** §3 "Admin and support access" — the mandatory `reason`. */
export const ADMIN_REASON_MIN_LENGTH = 10;
export const ADMIN_REASON_MAX_LENGTH = 500;

/** §4 "Retention and privacy". */
export const DEFAULT_MESSAGE_RETENTION_DAYS = 730;
export const MIN_MESSAGE_RETENTION_DAYS = 90;
/** Conversations anonymized per sweep invocation, so a backlog drains over successive days. */
export const RETENTION_SWEEP_BATCH = 1000;

/** §3 "Active vs. archived" — the booking statuses whose conversation is read-only. */
export const ARCHIVED_BOOKING_STATUSES: readonly BookingStatus[] = ['settled', 'cancelled', 'refunded', 'failed'];

/**
 * §3 "Contact-sharing protection" — the statuses a booking can be in WITHOUT ever having reached
 * `confirmed`. Every other status is reachable only through `confirmed` (spec 020/021/023 transition
 * tables), so for them master spec §54's "after booking" applies.
 */
export const PRE_CONFIRMATION_BOOKING_STATUSES: readonly BookingStatus[] = ['pending', 'failed'];

// No server-only import belongs in this file: the booking conversation UI imports these constants.
