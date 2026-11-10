import { ApiRouteError, validationError } from '@/lib/api/errors';

/** Spec 013 §3 "Error codes" — extends the shared taxonomy (lib/api/errors.ts), the same way
 * spec 005/008/009/010/012 each extend it in their own §3. */

/** §3: AI could not confidently extract intent; frontend falls back to plain keyword search. */
export function interpretationLowConfidenceError(): ApiRouteError {
  return new ApiRouteError(
    'INTERPRETATION_LOW_CONFIDENCE',
    'Could not confidently interpret that query — try a plain keyword search instead.',
    { status: 422 },
  );
}

export { validationError };
