import { beforeEach, describe, expect, it } from 'vitest';
import {
  SANDBOX_DECLINE_AMOUNT_SUFFIX,
  SANDBOX_REFERENCE_PREFIX,
  SANDBOX_REQUIRES_ACTION_AMOUNT_SUFFIX,
  getSandboxPaymentProvider,
} from './sandbox';

const provider = getSandboxPaymentProvider();
const PKR = 'PKR';

function amount(suffix: number): number {
  return 32 * 10_000 + suffix;
}

/** Spec 021 §3 "Payment-provider architecture" — the sandbox adapter. */
describe('sandbox payment provider (spec 021 §3)', () => {
  beforeEach(() => provider.reset());

  /**
   * The adapter must be self-describing: `isSandbox` and the `sandbox_` reference prefix are what
   * make simulated behaviour impossible to mistake for a real provider confirmation, in the
   * database, in logs and in operator tooling (master spec §132.21).
   */
  it('declares itself a sandbox and prefixes every reference it issues', async () => {
    expect(provider.isSandbox).toBe(true);
    expect(provider.name).toBe('sandbox');

    const result = await provider.authorize({ idempotencyKey: 'k1', amountMinorUnits: amount(0), currencyCode: PKR, reference: 'r' });
    expect(result.providerReference.startsWith(SANDBOX_REFERENCE_PREFIX)).toBe(true);
  });

  it('authorizes an ordinary amount', async () => {
    const result = await provider.authorize({ idempotencyKey: 'k1', amountMinorUnits: amount(0), currencyCode: PKR, reference: 'r' });
    expect(result.outcome).toBe('authorized');
  });

  it('declines the reserved decline amount and reports a machine code', async () => {
    const result = await provider.authorize({
      idempotencyKey: 'k1',
      amountMinorUnits: amount(SANDBOX_DECLINE_AMOUNT_SUFFIX),
      currencyCode: PKR,
      reference: 'r',
    });
    expect(result.outcome).toBe('failed');
    expect(result.failureCode).toBe('card_declined');
  });

  it('reports requires_action for the reserved step-up amount', async () => {
    const result = await provider.authorize({
      idempotencyKey: 'k1',
      amountMinorUnits: amount(SANDBOX_REQUIRES_ACTION_AMOUNT_SUFFIX),
      currencyCode: PKR,
      reference: 'r',
    });
    expect(result.outcome).toBe('requires_action');
    expect(result.actionKind).toBe('three_d_secure');
  });

  /**
   * AC-7's provider half. Real providers deduplicate on the idempotency key; the sandbox must too,
   * or the application's own idempotency would be the only line of defence and the two-level
   * guarantee §3 describes would be untested.
   */
  it('replays one result per idempotency key rather than authorizing twice', async () => {
    const first = await provider.authorize({ idempotencyKey: 'same', amountMinorUnits: amount(0), currencyCode: PKR, reference: 'r' });
    const second = await provider.authorize({ idempotencyKey: 'same', amountMinorUnits: amount(0), currencyCode: PKR, reference: 'r' });
    expect(second).toEqual(first);
    expect(second.providerReference).toBe(first.providerReference);
  });

  it('captures an authorization and reports it back through getStatus', async () => {
    const authorized = await provider.authorize({ idempotencyKey: 'k1', amountMinorUnits: amount(0), currencyCode: PKR, reference: 'r' });
    const captured = await provider.capture({
      idempotencyKey: 'k2',
      amountMinorUnits: amount(0),
      currencyCode: PKR,
      providerReference: authorized.providerReference,
    });
    expect(captured.outcome).toBe('captured');
    expect((await provider.getStatus(authorized.providerReference)).outcome).toBe('captured');
  });

  it('refuses a capture larger than its authorization, and one against an unknown reference', async () => {
    const authorized = await provider.authorize({ idempotencyKey: 'k1', amountMinorUnits: amount(0), currencyCode: PKR, reference: 'r' });
    const over = await provider.capture({
      idempotencyKey: 'k2',
      amountMinorUnits: amount(0) + 1,
      currencyCode: PKR,
      providerReference: authorized.providerReference,
    });
    expect(over.outcome).toBe('failed');
    expect(over.failureCode).toBe('capture_exceeds_authorization');

    const unknown = await provider.capture({
      idempotencyKey: 'k3',
      amountMinorUnits: 1_000,
      currencyCode: PKR,
      providerReference: 'sandbox_nope',
    });
    expect(unknown.outcome).toBe('failed');
    expect(unknown.failureCode).toBe('unknown_reference');
  });
});
