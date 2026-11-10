import { ApiRouteError, validationError } from '@/lib/api/errors';

/** Spec 011 §3 "Error codes" — extends the shared taxonomy the same way spec 010's
 * `lib/catalog/errors.ts` does. */

export function servicePageNotFoundError(message = 'The requested entity does not exist.'): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', message);
}

/** §3 `403 FORBIDDEN` — provider attempts to edit another provider's FAQ, or edit official
 * FAQs (or isn't a provider offering this service at all). */
export function faqOwnershipForbiddenError(message = 'You do not have permission to manage this FAQ.'): ApiRouteError {
  return new ApiRouteError('FORBIDDEN', message);
}

export { validationError };
