import { NextResponse } from 'next/server';
import type { ApiError, ApiResponse, PagedResponse } from '@/lib/types/api';
import { CORRELATION_ID_HEADER } from './correlation-id';
import { API_ERROR_CODES, type ApiErrorCode } from './errors';

/**
 * Envelope builders — spec 004 §3. Every `/api/v1/*` route (other than the two infra endpoints
 * this spec itself defines, `/health` and `/openapi.json`, which use their own documented shape)
 * should build its response through these rather than calling `NextResponse.json` directly, so
 * every endpoint gets the same envelope, headers, and correlation-ID propagation for free.
 */

function withCorrelationHeader(res: NextResponse, correlationId: string): NextResponse {
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
}

export function apiSuccess<T>(data: T, correlationId: string, init?: { status?: number }): NextResponse {
  const body: ApiResponse<T> = { data, correlationId };
  return withCorrelationHeader(NextResponse.json(body, { status: init?.status ?? 200 }), correlationId);
}

export function apiPaged<T>(
  data: T[],
  page: { limit: number; offset: number; total: number; nextOffset: number | null },
  correlationId: string,
): NextResponse {
  const body: PagedResponse<T> = { data, page, correlationId };
  return withCorrelationHeader(NextResponse.json(body, { status: 200 }), correlationId);
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  correlationId: string,
  options?: { errors?: { field: string; message: string }[]; retryAfterSeconds?: number },
): NextResponse {
  const status = API_ERROR_CODES[code];
  const body: ApiError = { status, code, message, errors: options?.errors, correlationId };
  const res = NextResponse.json(body, { status });
  if (options?.retryAfterSeconds !== undefined) {
    res.headers.set('Retry-After', String(Math.max(0, Math.ceil(options.retryAfterSeconds))));
  }
  return withCorrelationHeader(res, correlationId);
}
