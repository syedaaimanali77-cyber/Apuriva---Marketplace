/**
 * Spec 034 §3.7 — this spec adds NO error codes. These helpers only build the existing ones.
 */
import { ApiRouteError } from '@/lib/api/errors';

/**
 * Missing, deleted and not-owned all return the identical `404` (the convention spec 015 §3 records
 * from specs 008 and 012), so the response never reveals whether an id belongs to someone else.
 */
export function aiNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'Not found.');
}

/** Spec 004's `409`: the same `Idempotency-Key` reused with a different body. Nothing is written. */
export function idempotencyKeyConflictError(): ApiRouteError {
  return new ApiRouteError('IDEMPOTENCY_KEY_CONFLICT', 'This Idempotency-Key was already used for a different request.', {
    status: 409,
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids are compared to `uuid` columns; anything that cannot be one is simply not found. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
