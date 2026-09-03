/**
 * Error-code taxonomy — spec 004 §3 "Error codes". This table is the baseline; each subsequent
 * domain spec extends it in that spec's own §3 with additional codes following the same
 * SCREAMING_SNAKE_CASE + stability rule (never repurpose or rename a shipped code).
 */
export const API_ERROR_CODES = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DOMAIN_RULE_VIOLATION: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_CODES;

/**
 * Thrown by route handler logic and caught by `withApiRoute` (lib/api/handler.ts), which
 * converts it into the standard `ApiError` envelope. Lets a handler `throw` at the point of
 * failure instead of threading an early-return response object through nested logic.
 */
export class ApiRouteError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly errors?: { field: string; message: string }[];
  /** Only set for RATE_LIMITED — seconds until the caller may retry. */
  readonly retryAfterSeconds?: number;

  constructor(
    code: ApiErrorCode,
    message: string,
    options?: { errors?: { field: string; message: string }[]; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'ApiRouteError';
    this.code = code;
    this.status = API_ERROR_CODES[code];
    this.errors = options?.errors;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

/** AC-3: 400 VALIDATION_ERROR with an `errors[]` array naming each invalid field. */
export function validationError(errors: { field: string; message: string }[]): ApiRouteError {
  return new ApiRouteError('VALIDATION_ERROR', 'The request failed validation.', { errors });
}

/** AC-4: 403 FORBIDDEN for an authenticated request lacking permission. */
export function forbiddenError(message = 'You do not have permission to perform this action.'): ApiRouteError {
  return new ApiRouteError('FORBIDDEN', message);
}

/** AC-5: 429 RATE_LIMITED with the seconds until the caller may retry. */
export function rateLimitedError(retryAfterSeconds: number): ApiRouteError {
  return new ApiRouteError('RATE_LIMITED', 'Rate limit exceeded.', { retryAfterSeconds });
}
