/**
 * Spec 027 §3 "Error codes". None of these belongs in spec 004's shared `API_ERROR_CODES` map, so
 * each passes `options.status` explicitly — the pattern specs 005/016/020–026 follow.
 *
 * `fileNotFoundError` is the load-bearing one (AC-6): "no such asset", "soft-deleted" and "not
 * authorized" are deliberately indistinguishable, so ids can never be probed. Nothing in this
 * module ever returns `403` for an ownership failure.
 */
import { ApiRouteError } from '@/lib/api/errors';

export function fileNotFoundError(): ApiRouteError {
  return new ApiRouteError('FILE_NOT_FOUND', 'File not found.', { status: 404 });
}

export function fileTypeNotAllowedError(message = 'That file type is not allowed.'): ApiRouteError {
  return new ApiRouteError('FILE_TYPE_NOT_ALLOWED', message, { status: 400 });
}

export function fileTooLargeError(maxBytes: number): ApiRouteError {
  return new ApiRouteError('FILE_TOO_LARGE', `That file is larger than the ${maxBytes}-byte limit for its kind.`, {
    status: 400,
    details: { maxBytes },
  });
}

export function fileNotReadyError(status: string): ApiRouteError {
  return new ApiRouteError('FILE_NOT_READY', 'This file is not available yet.', { status: 409, details: { status } });
}

export function fileRejectedError(reasonCode: string): ApiRouteError {
  return new ApiRouteError('FILE_REJECTED', 'This file was rejected and cannot be used.', {
    status: 409,
    details: { reasonCode },
  });
}

export function fileContextNotAvailableError(contextType: string): ApiRouteError {
  return new ApiRouteError('FILE_CONTEXT_NOT_AVAILABLE', 'Files cannot be attached to that context yet.', {
    status: 422,
    details: { contextType },
  });
}

export function fileContextLimitReachedError(maxPerContext: number): ApiRouteError {
  return new ApiRouteError('FILE_CONTEXT_LIMIT_REACHED', `At most ${maxPerContext} files may be attached here.`, {
    status: 422,
    details: { maxPerContext },
  });
}

export function fileNotUploadedError(): ApiRouteError {
  return new ApiRouteError('FILE_NOT_UPLOADED', 'No uploaded object was found for this file.', { status: 422 });
}

export function idempotencyKeyConflictError(): ApiRouteError {
  return new ApiRouteError('IDEMPOTENCY_KEY_CONFLICT', 'That Idempotency-Key was already used with a different request.', {
    status: 409,
  });
}

export function fileStorageUnavailableError(message: string): ApiRouteError {
  return new ApiRouteError('FILE_STORAGE_UNAVAILABLE', message, { status: 503 });
}
