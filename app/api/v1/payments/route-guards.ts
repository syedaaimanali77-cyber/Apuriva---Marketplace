/**
 * Spec 021 §3 "Endpoints" — the guard sequence every payment browser route shares.
 *
 * VALIDATION ORDER IS NORMATIVE and identical on every route: (1) session, (2) CSRF, (3) active
 * mode, (4) rate limit, (5) `Idempotency-Key`. Keeping it in one place is what makes it impossible
 * for one payment route to be accidentally laxer than another.
 *
 * `withApiRoute` (spec 004) forwards only `(request, correlationId)`, never Next's route `context`,
 * so a `{id}` route reads its own parameter from the URL — the pattern
 * `app/api/v1/bookings/booking-id.ts` and `app/api/v1/offers/offer-id.ts` established.
 */
import { forbiddenError, rateLimitedError } from '@/lib/api/errors';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { PaymentProviderUnavailable } from '@/lib/payments';
import { paymentProviderUnavailableError } from '@/lib/payments/errors';

export interface PaymentRouteContext {
  userId: string;
  mode: 'customer' | 'provider';
}

/** Steps 1–4, plus the mode the route demands. Rate limiting uses spec 004's existing `payment` domain. */
export async function guardPaymentMutation(
  request: Request,
  requiredMode: 'customer' | 'provider',
): Promise<PaymentRouteContext> {
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
export async function guardPaymentRead(request: Request): Promise<PaymentRouteContext> {
  const session = await requireSession(request);

  const mode = session.activeMode;
  if (mode !== 'customer' && mode !== 'provider') {
    throw forbiddenError('This action requires customer or provider mode.');
  }

  const limit = checkRateLimit('payment', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  return { userId: session.userId, mode };
}

/** Step 5. Required on every payment mutation so a retry is a replay, never a second charge. */
export function paymentIdempotencyKey(request: Request): string {
  return requireIdempotencyKey(request);
}

/**
 * AC-10 — turns an unresolvable adapter into `503 PAYMENT_PROVIDER_UNAVAILABLE` rather than a 500.
 * Wraps the domain call so no route has to remember to do it.
 */
export async function withProviderGuard<T>(run: () => Promise<T>): Promise<T> {
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
