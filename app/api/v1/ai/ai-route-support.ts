/**
 * Spec 034 §3.2 — shared route plumbing for `/api/v1/ai/*`.
 *
 * The id is read from the URL path rather than a Next.js `params` promise, as spec 032's
 * `supportTicketIdFromUrl` does, so these handlers run identically when driven directly with a plain
 * `Request` in integration tests.
 */
import { NextResponse } from 'next/server';
import { CORRELATION_ID_HEADER } from '@/lib/api/correlation-id';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';

export function aiIdFromUrl(request: Request, depthFromEnd = 0): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}

/**
 * Every route except the two AI-calling ones uses the shared `default` domain (§3.2 "Rate
 * limiting"). The message and temporary-turn routes add NO check of their own: `completeAi()` already
 * limits them on spec 033's `ai` domain.
 */
export function enforceDefaultRateLimit(userId: string): void {
  const limit = checkRateLimit('default', userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);
}

export function noContent(correlationId: string): NextResponse {
  const res = new NextResponse(null, { status: 204 });
  res.headers.set(CORRELATION_ID_HEADER, correlationId);
  return res;
}
