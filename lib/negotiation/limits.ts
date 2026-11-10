/**
 * Spec 019 §3 — the named constants of negotiation. Fixed in code for this spec; runtime configuration
 * is spec 041's. The database enforces the revision cap independently (`offer_revisions_number_ck`).
 */
import { sql } from 'drizzle-orm';
import { MAX_REVISIONS_PER_REQUEST_PROVIDER } from '@/lib/db/schema';

/** Anti-spam: at most this many rows per sender per thread in any rolling window. */
export const THREAD_MESSAGE_LIMIT = 5;
export const THREAD_MESSAGE_WINDOW_MS = 10 * 60_000;
/** The SQL literal the database-side count uses; kept beside the constant it corresponds to. */
export const THREAD_MESSAGE_WINDOW_SQL = sql.raw(`interval '10 minutes'`);

export const MAX_REVISIONS = MAX_REVISIONS_PER_REQUEST_PROVIDER;

export const MESSAGE_BODY_MAX_LENGTH = 1000;
export const CHANGE_REQUEST_NOTE_MAX_LENGTH = 500;
/** `offer_messages_body_length_ck` — input bound plus headroom for redaction placeholders. */
export const STORED_BODY_MAX_LENGTH = 1100;

export const COMPARISON_MIN_OFFERS = 2;
export const COMPARISON_MAX_OFFERS = 3;

/** `nearby` reason: `location.normalized ≥ 0.8` ≡ within 10 km under spec 017's 50 km decay. */
export const NEARBY_MIN_LOCATION_SCORE = 0.8;

/** Statuses in which a pre-selection thread accepts new posts (AC-8). */
export const OPEN_THREAD_REQUEST_STATUSES = ['matching', 'offers_open'] as const;
