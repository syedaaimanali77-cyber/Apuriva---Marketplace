import { ApiRouteError } from '@/lib/api/errors';
import type { ActiveMode } from '@/lib/types/users';

/**
 * Spec 006 §3 domain-specific error code, extending spec 004's shared taxonomy (spec 004 §3:
 * "extends this table ... following the same SCREAMING_SNAKE_CASE and stability rule").
 */
export function profileNotFoundForModeError(mode: ActiveMode): ApiRouteError {
  return new ApiRouteError('PROFILE_NOT_FOUND_FOR_MODE', `No ${mode} profile exists for this account.`, {
    status: 422,
  });
}
