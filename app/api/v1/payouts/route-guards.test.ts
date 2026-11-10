import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
const fail = new Set<string>();

function step(name: string, error: () => Error) {
  return (..._args: unknown[]) => {
    calls.push(name);
    if (fail.has(name)) throw error();
    return undefined;
  };
}

vi.mock('@/lib/auth/require-session', () => ({
  requireSession: vi.fn(async () => {
    calls.push('session');
    if (fail.has('session')) throw Object.assign(new Error('unauthenticated'), { code: 'UNAUTHENTICATED' });
    return { id: 's1', userId: 'u1', activeMode: 'provider' };
  }),
  requireCsrf: vi.fn(step('csrf', () => Object.assign(new Error('csrf'), { code: 'CSRF_TOKEN_INVALID' }))),
}));
vi.mock('@/lib/auth/require-mode', () => ({ requireActiveMode: vi.fn(step('mode', () => Object.assign(new Error('mode'), { code: 'FORBIDDEN' }))) }));
vi.mock('@/lib/auth/step-up', () => ({ requireStepUp: vi.fn(step('step_up', () => Object.assign(new Error('step'), { code: 'STEP_UP_REQUIRED' }))) }));
vi.mock('@/lib/api/rate-limit', () => ({
  checkRateLimit: vi.fn(() => {
    calls.push('rate_limit');
    return fail.has('rate_limit') ? { allowed: false, retryAfterSeconds: 5 } : { allowed: true };
  }),
}));
vi.mock('@/lib/api/idempotency', () => ({ requireIdempotencyKey: vi.fn(step('idempotency', () => Object.assign(new Error('key'), { code: 'VALIDATION_ERROR' }))) }));
vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('@/lib/offers/db', () => ({ queryRows: vi.fn(async () => (fail.has('profile') ? [] : [{ id: 'pp1' }])) }));

const guards = await import('./route-guards');
const { PayoutProviderUnavailable } = await import('@/lib/payments/provider/payout-factory');
const { PlatformFeeUnconfigured } = await import('@/lib/payouts/fees');

const request = () => new Request('http://localhost/api/v1/providers/me/payout-methods', { method: 'POST' });

/** Spec 024 §3.12 — the normative guard order, and fail-fast at the first failure. */
describe('payout route guards (spec 024 §3.12)', () => {
  beforeEach(() => {
    calls.length = 0;
    fail.clear();
  });

  it('a payout-method mutation runs session → CSRF → mode → step-up → rate limit, in that order', async () => {
    await expect(guards.guardProviderPayoutMethodMutation(request())).resolves.toEqual({ userId: 'u1', providerProfileId: 'pp1' });
    expect(calls).toEqual(['session', 'csrf', 'mode', 'step_up', 'rate_limit']);
    guards.payoutIdempotencyKey(request());
    expect(calls.at(-1)).toBe('idempotency');
  });

  it('short-circuits at the first failure: no step-up or rate limit after a CSRF failure', async () => {
    fail.add('csrf');
    await expect(guards.guardProviderPayoutMethodMutation(request())).rejects.toMatchObject({ code: 'CSRF_TOKEN_INVALID' });
    expect(calls).toEqual(['session', 'csrf']);
  });

  it('step-up is checked after mode and before rate limiting', async () => {
    fail.add('step_up');
    await expect(guards.guardProviderPayoutMethodMutation(request())).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(calls).toEqual(['session', 'csrf', 'mode', 'step_up']);
  });

  it('a provider read needs no CSRF and no step-up', async () => {
    await guards.guardProviderPayoutRead(request());
    expect(calls).toEqual(['session', 'mode', 'rate_limit']);
  });

  it('a missing provider profile is refused, never an empty success', async () => {
    fail.add('profile');
    await expect(guards.guardProviderPayoutRead(request())).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an unconfigured rail or fee rate becomes 503, never 500', async () => {
    await expect(guards.withPayoutProviderGuard(async () => { throw new PayoutProviderUnavailable('x'); })).rejects.toMatchObject({ code: 'PAYOUT_PROVIDER_UNAVAILABLE', status: 503 });
    await expect(guards.withPayoutProviderGuard(async () => { throw new PlatformFeeUnconfigured('x'); })).rejects.toMatchObject({ code: 'PLATFORM_FEE_UNCONFIGURED', status: 503 });
  });
});
