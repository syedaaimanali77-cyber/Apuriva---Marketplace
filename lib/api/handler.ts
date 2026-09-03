import { NextResponse } from 'next/server';
import { getOrCreateCorrelationId } from './correlation-id';
import { ApiRouteError } from './errors';
import { apiError } from './response';
import { logForbiddenAttempt } from './security-log';

/**
 * Composes a Route Handler body with the standard envelope/error handling (spec 004 §3, AC-1
 * through AC-5): derives the correlation ID once, runs `handler`, and converts any thrown
 * `ApiRouteError` (or unexpected error) into the standard `ApiError` envelope — so individual
 * routes only need to `throw` at the point of failure and return their success payload via
 * `apiSuccess`/`apiPaged` (lib/api/response.ts) on the happy path.
 */
export function withApiRoute(
  handler: (request: Request, correlationId: string) => Promise<NextResponse>,
): (request: Request) => Promise<NextResponse> {
  return async (request: Request) => {
    const correlationId = getOrCreateCorrelationId(request);

    try {
      return await handler(request, correlationId);
    } catch (err) {
      if (err instanceof ApiRouteError) {
        if (err.code === 'FORBIDDEN') {
          logForbiddenAttempt({
            correlationId,
            method: request.method,
            path: new URL(request.url).pathname,
            reason: err.message,
          });
        }
        return apiError(err.code, err.message, correlationId, {
          errors: err.errors,
          retryAfterSeconds: err.retryAfterSeconds,
        });
      }

      // AC-2/§3: never expose internal error detail to the client; the real error still goes
      // to stderr, correlated by the same ID the caller received in the response.
      console.error(JSON.stringify({ event: 'api.unhandled_error', correlationId, error: String(err) }));
      return apiError('INTERNAL_ERROR', 'An unexpected error occurred.', correlationId);
    }
  };
}
