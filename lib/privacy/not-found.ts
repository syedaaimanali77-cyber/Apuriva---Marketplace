import { ApiRouteError } from '@/lib/api/errors';

/**
 * Spec 008 §3: a resource that doesn't exist, and one that exists but belongs to another user,
 * must return the identical response — otherwise the response itself leaks whether a given
 * id belongs to someone else. Used for session ids and data-export request ids.
 */
export function NOT_FOUND_ERROR(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'Not found.');
}
