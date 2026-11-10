import { ApiRouteError, validationError } from '@/lib/api/errors';

/**
 * Spec 015 §3 "Error codes" — the domain-specific codes this spec adds to the shared taxonomy
 * (lib/api/errors.ts), the same way spec 005/008/009/010/012 each extend it in their own §3.
 */

/**
 * §3: a request that doesn't exist **or** isn't the caller's — identical either way, never
 * revealing which case it was. This follows the repo's established privacy-preserving pattern
 * (spec 012's `addressNotFoundError`, spec 008's session/data-export ownership) rather than a
 * `403`, which would confirm that a given request id exists.
 */
export function requestNotFoundError(): ApiRouteError {
  return new ApiRouteError('REQUEST_NOT_FOUND', 'The requested request does not exist.', { status: 404 });
}

/** §3 Versioning: `expectedVersion` doesn't match, or a concurrent transition won the race. */
export function requestVersionConflictError(): ApiRouteError {
  return new ApiRouteError('CONFLICT', 'This request has been modified since you last read it.');
}

/** §3 Idempotency: the same `Idempotency-Key` replayed with a different body. Nothing is written. */
export function idempotencyKeyConflictError(): ApiRouteError {
  return new ApiRouteError(
    'IDEMPOTENCY_KEY_CONFLICT',
    'This Idempotency-Key was already used for a different request.',
    { status: 409 },
  );
}

/**
 * §3/AC-7: the request's current state is not one of `submitted`/`matching`/`offers_open`.
 * Distinct from `CONFLICT`, which is reserved for a version/concurrency race.
 */
export function requestNotCancellableError(status: string): ApiRouteError {
  return new ApiRouteError(
    'REQUEST_NOT_CANCELLABLE',
    `A request in "${status}" can no longer be cancelled here.`,
    { status: 422 },
  );
}

export { validationError };
