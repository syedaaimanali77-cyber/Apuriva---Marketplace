import { ApiRouteError, validationError } from '@/lib/api/errors';

/** Spec 012 §3 "Error codes" — the domain-specific codes this spec adds to the shared taxonomy
 * (lib/api/errors.ts), the same way spec 005/008/009/010 each extend it in their own §3. */

export function geocodingFailedError(message = 'Could not resolve that address.'): ApiRouteError {
  return new ApiRouteError('GEOCODING_FAILED', message, { status: 422 });
}

export function exactLocationNotAuthorizedError(
  message = 'You are not authorized to view the exact location for this resource.',
): ApiRouteError {
  return new ApiRouteError('EXACT_LOCATION_NOT_AUTHORIZED', message, { status: 403 });
}

/** §3: a `PATCH`/`DELETE` target that doesn't exist or doesn't belong to the caller — identical
 * either way, never revealing which case it was (same pattern as spec 008's session revocation). */
export function addressNotFoundError(): ApiRouteError {
  return new ApiRouteError('ADDRESS_NOT_FOUND', 'The requested address does not exist.', { status: 404 });
}

/** §3: `DELETE` target is still referenced by a booking (`restrict` FK) — see §4 retention. */
export function addressInUseError(): ApiRouteError {
  return new ApiRouteError(
    'ADDRESS_IN_USE',
    'This address is still referenced by a booking and cannot be deleted.',
    { status: 409 },
  );
}

export { validationError };
