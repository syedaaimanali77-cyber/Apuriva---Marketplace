/**
 * Spec 024 §3.12 — the guard sequence every payout route shares, in the idiom of
 * `app/api/v1/refunds/route-guards.ts`. This directory holds no `route.ts`, so
 * `scripts/check-openapi-drift.ts` has nothing to register here.
 *
 * VALIDATION ORDER IS NORMATIVE and identical on every route:
 *   session → CSRF → active mode / admin permission → step-up → rate limit → Idempotency-Key
 *
 * Rate limiting reuses spec 004's existing `payment` domain (10 / 60s). Admin PERMISSION checks are
 * spec 009's `resolvePermission`, performed inside `lib/payouts/**` so a route cannot skip them.
 */
import { forbiddenError, rateLimitedError } from '@/lib/api/errors';
import { requireIdempotencyKey } from '@/lib/api/idempotency';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { requireActiveMode } from '@/lib/auth/require-mode';
import { requireStepUp } from '@/lib/auth/step-up';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { PayoutProviderUnavailable } from '@/lib/payments/provider/payout-factory';
import { PlatformFeeUnconfigured } from '@/lib/payouts/fees';
import { payoutProviderUnavailableError, platformFeeUnconfiguredError } from '@/lib/payouts/errors';
import { sql } from 'drizzle-orm';

/** Spec 024 §3.9 — the single step-up action every payout-method mutation requires. */
export const MANAGE_PAYOUT_METHOD_STEP_UP_ACTION = 'manage_payout_method';

export interface ProviderPayoutContext {
  userId: string;
  providerProfileId: string;
}

async function resolveOwnProviderProfile(userId: string): Promise<string> {
  const [row] = await queryRows<{ id: string }>(getDb(), sql`SELECT id FROM provider_profiles WHERE user_id = ${userId}`);
  // A session in provider mode always has a profile (spec 006); an absent row is refused, never an
  // empty success.
  if (!row) throw forbiddenError('This action requires a provider profile.');
  return row.id;
}

function rateLimit(userId: string): void {
  const limit = checkRateLimit('payment', userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);
}

/** A provider read: session + provider mode + rate limit. No CSRF on a GET. */
export async function guardProviderPayoutRead(request: Request): Promise<ProviderPayoutContext> {
  const session = await requireSession(request);
  requireActiveMode(session, 'provider');
  rateLimit(session.userId);
  return { userId: session.userId, providerProfileId: await resolveOwnProviderProfile(session.userId) };
}

/** A payout-method mutation: session + CSRF + provider mode + STEP-UP + rate limit (AC-4). */
export async function guardProviderPayoutMethodMutation(request: Request): Promise<ProviderPayoutContext> {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireActiveMode(session, 'provider');
  requireStepUp(request, session, MANAGE_PAYOUT_METHOD_STEP_UP_ACTION);
  rateLimit(session.userId);
  return { userId: session.userId, providerProfileId: await resolveOwnProviderProfile(session.userId) };
}

/** Admin surfaces: session + CSRF (mutations) + rate limit; permission is checked in the domain. */
export async function guardAdminPayoutRequest(request: Request, options?: { csrf?: boolean }): Promise<{ userId: string }> {
  const session = await requireSession(request);
  if (options?.csrf !== false) requireCsrf(request, session.id);
  rateLimit(session.userId);
  return { userId: session.userId };
}

/** Step 6. Required on every POST so an HTTP retry is a replay, never a second effect. */
export function payoutIdempotencyKey(request: Request): string {
  return requireIdempotencyKey(request);
}

/** Maps an unconfigured rail or fee rate to `503`, never a `500`. */
export async function withPayoutProviderGuard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PayoutProviderUnavailable) throw payoutProviderUnavailableError();
    if (err instanceof PlatformFeeUnconfigured) throw platformFeeUnconfiguredError();
    throw err;
  }
}

/** Reads the path segment at `fromEnd` (1 = last). `withApiRoute` forwards no route context. */
export function pathSegment(request: Request, fromEnd: number): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - fromEnd] ?? '');
}
