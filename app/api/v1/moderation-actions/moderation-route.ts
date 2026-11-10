/**
 * Spec 038 §3.13 — the two things every moderation route shares: the path id and the `moderation`
 * rate-limit bucket. Read from the path rather than a Next.js `params` promise for the reason spec
 * 030's `safetyReportIdFromUrl` gives: these handlers are driven directly in integration tests.
 */
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';

export function pathId(request: Request, depthFromEnd = 0): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}

export function enforceModerationRateLimit(userId: string): void {
  const limit = checkRateLimit('moderation', userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);
}
