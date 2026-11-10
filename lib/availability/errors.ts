/**
 * Spec 016 §3 "Error codes" — extends spec 004's `API_ERROR_CODES` table in the established
 * SCREAMING_SNAKE_CASE + stability way. These codes are not in the shared baseline map, so each
 * passes `options.status` explicitly, exactly as spec 005's `MFA_REQUIRED`/`OTP_EXPIRED` do.
 */
import { ApiRouteError } from '@/lib/api/errors';

export interface FieldError {
  field: string;
  message: string;
}

/**
 * `409 SLOT_OVERLAP` — a reservation, or a schedule/override change, conflicts with an occupied
 * interval returned by the registered `BusyIntervalLoader`. The interval's `sourceId` is included
 * ONLY for the owning provider (§3 error table), never on a customer-facing path, so the caller
 * decides whether to pass it.
 */
export function slotOverlapError(message: string): ApiRouteError {
  return new ApiRouteError('SLOT_OVERLAP', message, { status: 409 });
}

/** `422 INVALID_SCHEDULE_RANGE` — any R2/R5/R6 violation, naming each offending entry index. */
export function invalidScheduleRangeError(errors: FieldError[]): ApiRouteError {
  return new ApiRouteError('INVALID_SCHEDULE_RANGE', 'The schedule contains an invalid time range.', {
    status: 422,
    errors,
  });
}

/** `422 INVALID_SERVICE_AREA` — any S5 violation. */
export function invalidServiceAreaError(errors: FieldError[]): ApiRouteError {
  return new ApiRouteError('INVALID_SERVICE_AREA', 'The service-area configuration is invalid.', {
    status: 422,
    errors,
  });
}

/** `422 AVAILABILITY_NOTIFY_NOT_APPLICABLE` — AC-6: the provider is already `available`. */
export function availabilityNotifyNotApplicableError(): ApiRouteError {
  return new ApiRouteError(
    'AVAILABILITY_NOTIFY_NOT_APPLICABLE',
    'This provider is already available, so there is nothing to be notified about.',
    { status: 422 },
  );
}

/**
 * `404 NOT_FOUND` for an unknown provider id — deliberately `404` rather than `403` (§3 error
 * table) so provider ids cannot be probed by observing which ones return a different status.
 */
export function providerNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'The requested provider does not exist.');
}

/** `404 NOT_FOUND` — the session user has no `provider_profiles` row of their own. */
export function providerProfileNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'You do not have a provider profile.');
}

/** `404 NOT_FOUND` — no override row exists for that local date. */
export function overrideNotFoundError(): ApiRouteError {
  return new ApiRouteError('NOT_FOUND', 'No override exists for that date.');
}

/** `409 CONFLICT` — stale `expectedVersion` (spec 003 AC-6); the current version lets the client refetch. */
export function scheduleVersionConflictError(currentVersion: number): ApiRouteError {
  return new ApiRouteError(
    'CONFLICT',
    `The schedule was changed by someone else. Current version is ${currentVersion}; refetch and retry.`,
  );
}

/** `409 CONFLICT` — R4: `POST` for a date that already has an override row. */
export function overrideAlreadyExistsError(date: string): ApiRouteError {
  return new ApiRouteError('CONFLICT', `An override already exists for ${date}. Update it instead.`);
}
