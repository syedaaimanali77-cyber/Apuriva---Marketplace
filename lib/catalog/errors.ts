import { ApiRouteError, validationError } from '@/lib/api/errors';

/**
 * Spec 010 §3 "Error codes" — the domain-specific codes this spec adds to the shared taxonomy
 * (lib/api/errors.ts), the same way spec 005/008/009 each extend it in their own §3.
 */

export function catalogForbiddenError(message = 'You do not have permission to perform this action.'): ApiRouteError {
  return new ApiRouteError('FORBIDDEN', message);
}

export function catalogNotFoundError(message = 'The requested catalog entity does not exist.'): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', message);
}

/** §3 Versioning: `expectedVersion` supplied on a `PATCH` doesn't match the row's current
 * `version`. */
export function versionConflictError(): ApiRouteError {
  return new ApiRouteError('CONFLICT', 'The entity has been modified since you last read it.');
}

/** §3 Slug rules: the normalized slug already exists in the scope it must be unique within. */
export function slugConflictError(slug: string): ApiRouteError {
  return new ApiRouteError('CONFLICT', `The slug "${slug}" is already in use in this scope.`);
}

/** §4 Taxonomy integrity: a service/subcategory references a category or subcategory that
 * doesn't exist, doesn't belong to the stated parent, or isn't active. */
export function invalidTaxonomyPathError(message = 'The referenced category/subcategory path is invalid or inactive.'): ApiRouteError {
  return new ApiRouteError('INVALID_TAXONOMY_PATH', message, { status: 422 });
}

/** §4 Lifecycle: the requested status change isn't a valid transition for that entity. */
export function invalidLifecycleTransitionError(from: string, to: string): ApiRouteError {
  return new ApiRouteError('INVALID_LIFECYCLE_TRANSITION', `"${from}" cannot transition to "${to}".`, { status: 422 });
}

/** §4 Retirement and reassignment: a category can't be retired while active services attached to
 * it (directly or via a subcategory) remain. */
export function categoryHasActiveServicesError(): ApiRouteError {
  return new ApiRouteError(
    'CATEGORY_HAS_ACTIVE_SERVICES',
    'This category has active services attached. Reassign or retire them first.',
    { status: 422 },
  );
}

/** §4 Retirement and reassignment: same rule as above, for a subcategory. */
export function subcategoryHasActiveServicesError(): ApiRouteError {
  return new ApiRouteError(
    'SUBCATEGORY_HAS_ACTIVE_SERVICES',
    'This subcategory has active services attached. Reassign or retire them first.',
    { status: 422 },
  );
}

/** §3 AI suggestion review: approving/rejecting a `CatalogSuggestion` that is no longer
 * `pending_review`. */
export function suggestionAlreadyReviewedError(): ApiRouteError {
  return new ApiRouteError('SUGGESTION_ALREADY_REVIEWED', 'This suggestion has already been reviewed.', { status: 409 });
}

export { validationError };
