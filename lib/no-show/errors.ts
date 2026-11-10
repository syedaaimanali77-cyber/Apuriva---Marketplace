/**
 * Spec 023 §3 "Error codes" — the no-show half.
 *
 * Privacy-safe by construction: a caller who is neither party to a report gets
 * `404 NO_SHOW_REPORT_NOT_FOUND`, never `403`, so report ids cannot be probed by observing a
 * different status. `403` is reserved for a party doing something they are structurally not
 * permitted to do (responding to their own report) and for an admin lacking a permission.
 */
import { ApiRouteError } from '@/lib/api/errors';

export function noShowReportNotFoundError(): ApiRouteError {
  return new ApiRouteError('NO_SHOW_REPORT_NOT_FOUND', 'No such no-show report.', { status: 404 });
}

export function noShowReportAlreadyExistsError(reportId: string): ApiRouteError {
  return new ApiRouteError(
    'NO_SHOW_REPORT_ALREADY_EXISTS',
    'You have already reported a no-show for this booking.',
    { status: 409, details: { reportId } },
  );
}

/** `422` — outside the reporting window, or the booking is in a non-reportable status. */
export function noShowReportWindowClosedError(reason: string): ApiRouteError {
  return new ApiRouteError(
    'NO_SHOW_REPORT_WINDOW_CLOSED',
    'A no-show cannot be reported for this booking right now.',
    { status: 422, details: { reason } },
  );
}

/** `403` — the reporter attempting to respond to, withdraw-as-other-party, or resolve their own report. */
export function noShowSelfActionNotAllowedError(): ApiRouteError {
  return new ApiRouteError(
    'NO_SHOW_SELF_ACTION_NOT_ALLOWED',
    'The party who filed a report cannot respond to it or resolve it.',
    { status: 403 },
  );
}

export function noShowResponseAlreadyFiledError(): ApiRouteError {
  return new ApiRouteError('NO_SHOW_RESPONSE_ALREADY_FILED', 'A response has already been filed.', { status: 409 });
}

/**
 * `422` — AC-5 at the API surface: no consequence before the other party has responded or the
 * response window has elapsed.
 */
export function noShowResponseRequiredError(respondByAt: string): ApiRouteError {
  return new ApiRouteError(
    'NO_SHOW_RESPONSE_REQUIRED',
    'The other party has not responded yet and their response window has not elapsed.',
    { status: 422, details: { respondByAt } },
  );
}

export function noShowReportAlreadyResolvedError(): ApiRouteError {
  return new ApiRouteError('NO_SHOW_REPORT_ALREADY_RESOLVED', 'This report has already been resolved.', {
    status: 409,
  });
}

export function noShowOutcomeInvalidError(field: string, message: string): ApiRouteError {
  return new ApiRouteError('NO_SHOW_OUTCOME_INVALID', 'The resolution is invalid.', {
    status: 422,
    errors: [{ field, message }],
  });
}

/** `409` — the counterpart report already carries fault for this booking (AC-6's exactly-once). */
export function noShowFaultAlreadyRecordedError(): ApiRouteError {
  return new ApiRouteError(
    'NO_SHOW_FAULT_ALREADY_RECORDED',
    'A no-show has already been confirmed for this booking.',
    { status: 409 },
  );
}
