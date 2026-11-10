import { createHash } from 'node:crypto';
import { validationError } from './errors';

/**
 * Shared `Idempotency-Key` mechanism — introduced by spec 015 §3, deliberately generic so specs
 * 018/020/021/036 reuse it rather than adding a second, incompatible scheme (spec 015 §8 #3).
 *
 * This module owns only the two transport-level concerns every caller shares: reading/validating
 * the header, and canonicalizing a body into a stable fingerprint. *Where* the key is stored and
 * what a replay returns stays with the owning domain — spec 015 stores it on `requests`
 * (`idempotency_key` + `idempotency_fingerprint`, unique per `customer_profile_id`), the same
 * per-entity pattern specs 020/021 already declare for `Booking`/`Payment`.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** Bounded so a key can never be used to smuggle an unbounded string into an indexed column. */
const MAX_KEY_LENGTH = 255;

/**
 * Spec 015 §3: the header is required on `POST /api/v1/requests`. Missing/blank (or absurdly
 * long) is a `400 VALIDATION_ERROR` naming the header as the offending field, so the AI/MCP path
 * (spec 036's `MCP_IDEMPOTENCY_KEY_REQUIRED`) and the form path fail identically.
 */
export function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim() ?? '';
  if (value.length === 0) {
    throw validationError([{ field: IDEMPOTENCY_KEY_HEADER, message: 'is required' }]);
  }
  if (value.length > MAX_KEY_LENGTH) {
    throw validationError([{ field: IDEMPOTENCY_KEY_HEADER, message: `must be at most ${MAX_KEY_LENGTH} characters` }]);
  }
  return value;
}

/**
 * Stable SHA-256 over the canonicalized body: object keys sorted at every depth, so a retry that
 * serializes the same values in a different property order is recognized as the same request
 * rather than a conflicting one (spec 015 §3 "Conflicting reuse"). Array order is significant —
 * it carries meaning in a body (e.g. `attachmentIds`) and is never sorted away.
 */
export function idempotencyFingerprint(body: unknown): string {
  return createHash('sha256').update(canonicalize(body)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` and an absent key mean the same thing in a JSON body, so they must fingerprint
    // identically — otherwise `{ budget: undefined }` and `{}` would falsely conflict.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}
