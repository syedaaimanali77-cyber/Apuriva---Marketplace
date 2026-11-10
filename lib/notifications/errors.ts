/**
 * Spec 026 §3 "Error codes". None belongs in spec 004's shared `API_ERROR_CODES` map, so each passes
 * `options.status` explicitly — the pattern specs 005/016/020–025 follow.
 */
import { ApiRouteError } from '@/lib/api/errors';
import type { NotificationCategory } from '@/lib/types/notifications';

/** AC-9: no such notification OR another user's — deliberately indistinguishable. Never 403. */
export function notificationNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOTIFICATION_NOT_FOUND', 'Notification not found.', { status: 404 });
}

/** AC-2: an attempt to switch off a security, payments or operational notification. */
export function categoryNotOverridableError(category: NotificationCategory): ApiRouteError {
  return new ApiRouteError('CATEGORY_NOT_OVERRIDABLE', `${category} notifications can't be turned off.`, {
    status: 422,
    details: { category },
  });
}

/** Spec 003 AC-6 optimistic concurrency: the preferences changed since the caller read them. */
export function preferencesVersionConflictError(currentVersion: number): ApiRouteError {
  return new ApiRouteError('CONFLICT', 'Your notification preferences changed elsewhere. Reload and try again.', {
    details: { currentVersion },
  });
}
