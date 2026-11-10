/**
 * Spec 022 §3 "Endpoints" — the guard sequence every refund route shares.
 *
 * VALIDATION ORDER IS NORMATIVE and identical on every route: (1) session, (2) CSRF, (3) active
 * mode / admin permission, (4) rate limit, (5) `Idempotency-Key`. Keeping it in one place is what
 * makes it impossible for one refund route to be accidentally laxer than another.
 *
 * Rate limiting reuses spec 004's existing `payment` domain (10 / 60s): a refund is a
 * payment-adjacent financial write, and a second domain would only add a threshold to keep in sync.
 */
import { forbiddenError, rateLimitedError } from '@/lib/api/errors';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { PaymentProviderUnavailable } from '@/lib/payments';
import { paymentProviderUnavailableError } from '@/lib/refunds/errors';

export interface RefundRouteContext {
  userId: string;
  mode: 'customer' | 'provider';
}

/** Steps 1–4 for a participant mutation. */
export async function guardRefundMutation(
  request: Request,
  requiredMode: 'customer' | 'provider',
): Promise<RefundRouteContext> {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  if (session.activeMode !== requiredMode) {
    throw forbiddenError(`This action requires ${requiredMode} mode.`);
  }

  const limit = checkRateLimit('payment', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  return { userId: session.userId, mode: requiredMode };
}

/** A read: session + participant mode, no CSRF (a GET changes nothing), still rate limited. */
export async function guardRefundRead(request: Request): Promise<RefundRouteContext> {
  const session = await requireSession(request);

  const mode = session.activeMode;
  if (mode !== 'customer' && mode !== 'provider') {
    throw forbiddenError('This action requires customer or provider mode.');
  }

  const limit = checkRateLimit('payment', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  return { userId: session.userId, mode };
}

/**
 * Admin surfaces. Session + CSRF (for mutations) + rate limit; the PERMISSION check itself is spec
 * 009's `resolvePermission`, performed in the domain layer so it cannot be skipped by a route.
 */
export async function guardAdminRefundRequest(request: Request, options?: { csrf?: boolean }): Promise<{ userId: string }> {
  const session = await requireSession(request);
  if (options?.csrf !== false) requireCsrf(request, session.id);

  const limit = checkRateLimit('payment', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  return { userId: session.userId };
}

/** Step 5. Required on every refund mutation so a retry is a replay, never a second refund. */
export function refundIdempotencyKey(request: Request): string {
  return requireIdempotencyKey(request);
}

/** Turns an unresolvable adapter into `503 PAYMENT_PROVIDER_UNAVAILABLE` rather than a 500. */
export async function withRefundProviderGuard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PaymentProviderUnavailable) throw paymentProviderUnavailableError();
    throw err;
  }
}

/** The `{id}` segment, counted from the end of the path. */
export function idFromUrl(request: Request, depthFromEnd = 0): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1 - depthFromEnd] ?? '');
}
