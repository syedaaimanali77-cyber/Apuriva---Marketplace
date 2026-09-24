import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRouteError } from '@/lib/api/errors';
import { paymentFailedError } from '@/lib/payments/errors';
import { McpIdempotencyKeyRequiredError } from './errors';
import { MAX_AUTOMATIC_RETRIES, shouldRetry } from './retry-policy';

/**
 * The classification is swapped in per test, so the MECHANISM can be proven even though the real
 * classified set is empty (asserted against the actual module below).
 */
const classification = vi.hoisted(() => ({ transient: false }));
vi.mock('./transient-failures', () => ({ isTransientInfrastructureFailure: () => classification.transient }));

/** Spec 036 §3 "Retry policy" / AC-6. */
describe('spec 036 retry policy', () => {
  afterEach(() => {
    classification.transient = false;
  });

  it('allows at most one automatic retry', () => {
    expect(MAX_AUTOMATIC_RETRIES).toBe(1);
  });

  it('the REAL classification is empty — no failure is transient today, so nothing is retried automatically', async () => {
    const actual = await vi.importActual<typeof import('./transient-failures')>('./transient-failures');
    for (const err of [new Error('ECONNRESET'), new Error('timeout'), new Error('connection terminated')]) {
      expect(actual.isTransientInfrastructureFailure(err)).toBe(false);
    }
    expect(shouldRetry(new Error('ECONNRESET'), 0, false)).toBe(false);
  });

  it('never retries a domain/business error — including a declined payment that says the USER may retry', () => {
    classification.transient = true;
    expect(shouldRetry(new ApiRouteError('OFFER_EXPIRED', 'expired', { status: 422 }), 0, false)).toBe(false);
    expect(paymentFailedError().details).toMatchObject({ retryable: true });
    expect(shouldRetry(paymentFailedError(), 0, false)).toBe(false);
  });

  it('never retries a spec 035 pipeline error or MCP_IDEMPOTENCY_KEY_REQUIRED', () => {
    classification.transient = true;
    expect(shouldRetry(new ApiRouteError('MCP_AUTHORIZATION_FAILED', 'This action is not allowed.', { status: 403 }), 0, false)).toBe(false);
    expect(shouldRetry(new McpIdempotencyKeyRequiredError('create_booking'), 0, false)).toBe(false);
  });

  it('were a failure classified transient: exactly one retry, and never for a confirmed (single-use) action', () => {
    classification.transient = true;
    expect(shouldRetry(new Error('transient'), 0, false)).toBe(true);
    expect(shouldRetry(new Error('transient'), 1, false)).toBe(false);
    expect(shouldRetry(new Error('transient'), 0, true)).toBe(false);
  });
});
