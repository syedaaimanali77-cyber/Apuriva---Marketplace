import { beforeEach, describe, expect, it } from 'vitest';
import {
  SANDBOX_DECLINE_AMOUNT_SUFFIX,
  SANDBOX_REFERENCE_PREFIX,
  SANDBOX_REFUND_DECLINE_AMOUNT_SUFFIX,
  SANDBOX_REFUND_UNKNOWN_AMOUNT_SUFFIX,
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

/** Spec 022 §3 "Provider seam extension" — the refund primitives added to spec 021's adapter. */
describe('sandbox refunds (spec 022 §3)', () => {
  beforeEach(() => provider.reset());

  async function capturedPayment(paymentAmount = amount(0)): Promise<string> {
    const authorized = await provider.authorize({
      idempotencyKey: `auth-${Math.random()}`,
      amountMinorUnits: paymentAmount,
      currencyCode: PKR,
      reference: 'r',
    });
    await provider.capture({
      idempotencyKey: `cap-${Math.random()}`,
      amountMinorUnits: paymentAmount,
      currencyCode: PKR,
      providerReference: authorized.providerReference,
    });
    return authorized.providerReference;
  }

  it('refunds a captured payment and issues its own reference', async () => {
    const providerReference = await capturedPayment();
    const result = await provider.refund({
      idempotencyKey: 'r1',
      providerReference,
      amountMinorUnits: 10_000,
      currencyCode: PKR,
    });

    expect(result.outcome).toBe('refunded');
    // A refund reference is distinct from the payment's, and self-describing as a sandbox handle.
    expect(result.refundReference).not.toBe(providerReference);
    expect(result.refundReference?.startsWith(SANDBOX_REFERENCE_PREFIX)).toBe(true);
  });

  it('declines the reserved refund-decline amount with a machine code', async () => {
    const providerReference = await capturedPayment();
    const result = await provider.refund({
      idempotencyKey: 'r1',
      providerReference,
      amountMinorUnits: amount(SANDBOX_REFUND_DECLINE_AMOUNT_SUFFIX),
      currencyCode: PKR,
    });

    expect(result.outcome).toBe('failed');
    expect(result.failureCode).toBe('refund_declined');
  });

  /**
   * AC-7's adapter half, and the most important behaviour in this file: `unknown` is a real
   * outcome, and the refund IS settled on the provider side even though the caller never learned
   * it. That is exactly the shape that makes auto-failing dangerous.
   */
  it('reports unknown for the reserved ambiguity amount, while having actually refunded', async () => {
    const providerReference = await capturedPayment();
    const result = await provider.refund({
      idempotencyKey: 'r1',
      providerReference,
      amountMinorUnits: amount(SANDBOX_REFUND_UNKNOWN_AMOUNT_SUFFIX),
      currencyCode: PKR,
    });

    expect(result.outcome).toBe('unknown');
    expect(result.refundReference).not.toBeNull();

    // The status READ tells the truth — which is how the sweep resolves it without refunding twice.
    const status = await provider.getRefundStatus(result.refundReference!);
    expect(status.outcome).toBe('refunded');
  });

  /** AC-8's provider half: one key ⇒ one refund, replayed verbatim. */
  it('replays one refund per idempotency key rather than refunding twice', async () => {
    const providerReference = await capturedPayment();
    const first = await provider.refund({ idempotencyKey: 'same', providerReference, amountMinorUnits: 10_000, currencyCode: PKR });
    const second = await provider.refund({ idempotencyKey: 'same', providerReference, amountMinorUnits: 10_000, currencyCode: PKR });

    expect(second).toEqual(first);
    expect(second.refundReference).toBe(first.refundReference);
  });

  it('fails a refund against an unknown payment reference, issuing no refund reference', async () => {
    const result = await provider.refund({
      idempotencyKey: 'r1',
      providerReference: 'sandbox_nope',
      amountMinorUnits: 10_000,
      currencyCode: PKR,
    });

    expect(result.outcome).toBe('failed');
    expect(result.failureCode).toBe('unknown_reference');
    expect(result.refundReference).toBeNull();
  });

  /** An unresolvable reference stays `unknown` — never guessed into `failed`. */
  it('reports unknown for a refund reference it cannot resolve', async () => {
    const status = await provider.getRefundStatus('sandbox_refund_missing');
    expect(status.outcome).toBe('unknown');
  });
});
