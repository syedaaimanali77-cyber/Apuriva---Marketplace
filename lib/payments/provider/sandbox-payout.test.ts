import { beforeEach, describe, expect, it } from 'vitest';
import {
  getSandboxPayoutProvider,
  sandboxSetupToken,
  SANDBOX_PAYOUT_DESTINATION_INVALID_SUFFIX,
  SANDBOX_PAYOUT_DESTINATION_UNAVAILABLE_SUFFIX,
  SANDBOX_PAYOUT_PREFIX,
  SANDBOX_PAYOUT_REJECTED_SUFFIX,
  SANDBOX_PAYOUT_TEMPORARILY_UNAVAILABLE_SUFFIX,
  SANDBOX_PAYOUT_UNKNOWN_NO_REFERENCE_SUFFIX,
  SANDBOX_PAYOUT_UNKNOWN_SUFFIX,
} from './sandbox-payout';

const rail = getSandboxPayoutProvider();

async function destination(): Promise<string> {
  const registered = await rail.registerDestination(sandboxSetupToken('bank', String(1000 + Math.floor(Math.random() * 8999))));
  return registered!.destinationToken;
}

const amount = (suffix: number) => 50 * 10_000 + suffix;

/** Spec 024 §3.2 — the sandbox payout rail. */
describe('sandbox payout rail (spec 024 §3.2)', () => {
  beforeEach(() => rail.reset());

  it('declares itself a sandbox and prefixes every reference and destination token', async () => {
    expect(rail.isSandbox).toBe(true);
    expect(rail.name).toBe('sandbox');
    const token = await destination();
    expect(token.startsWith(SANDBOX_PAYOUT_PREFIX)).toBe(true);
    const result = await rail.transfer({ destinationToken: token, idempotencyKey: 'k', amountMinorUnits: amount(0), currencyCode: 'PKR', reference: 'r' });
    expect(result.outcome).toBe('paid');
    expect(result.payoutReference!.startsWith(SANDBOX_PAYOUT_PREFIX)).toBe(true);
  });

  it('registers a destination with a rail-supplied mask of at most four digits, and consumes the setup token', async () => {
    const setup = sandboxSetupToken('mobile_wallet', '9876', 'PKR');
    const registered = await rail.registerDestination(setup);
    expect(registered).toMatchObject({ type: 'mobile_wallet', maskedDetail: '****9876', institutionLabel: 'Sandbox Wallet', payoutCurrencyCode: 'PKR' });
    expect(registered!.maskedDetail.replace(/\D/g, '').length).toBeLessThanOrEqual(4);
    expect(await rail.registerDestination(setup)).toBeNull();
    expect(await rail.registerDestination('sandbox_setup:bank:12345678:PKR')).toBeNull();
    expect(await rail.registerDestination('not-a-token')).toBeNull();
  });

  it('honours idempotency keys: one key, one result, one transfer', async () => {
    const token = await destination();
    const input = { destinationToken: token, idempotencyKey: 'same', amountMinorUnits: amount(0), currencyCode: 'PKR', reference: 'r' };
    const first = await rail.transfer(input);
    const second = await rail.transfer(input);
    expect(second.payoutReference).toBe(first.payoutReference);
  });

  it('produces every definitive failure code deterministically by amount suffix', async () => {
    const token = await destination();
    const cases: Array<[number, string]> = [
      [SANDBOX_PAYOUT_DESTINATION_INVALID_SUFFIX, 'destination_invalid'],
      [SANDBOX_PAYOUT_REJECTED_SUFFIX, 'transfer_rejected'],
      [SANDBOX_PAYOUT_TEMPORARILY_UNAVAILABLE_SUFFIX, 'rail_temporarily_unavailable'],
      [SANDBOX_PAYOUT_DESTINATION_UNAVAILABLE_SUFFIX, 'destination_unavailable'],
    ];
    for (const [suffix, code] of cases) {
      const result = await rail.transfer({ destinationToken: token, idempotencyKey: `k${suffix}`, amountMinorUnits: amount(suffix), currencyCode: 'PKR', reference: 'r' });
      expect(result.outcome).toBe('failed');
      expect(result.failureCode).toBe(code);
    }
  });

  it('an unknown outcome is later resolved as paid by a read — never collapsed into failed', async () => {
    const token = await destination();
    const unknown = await rail.transfer({ destinationToken: token, idempotencyKey: 'u', amountMinorUnits: amount(SANDBOX_PAYOUT_UNKNOWN_SUFFIX), currencyCode: 'PKR', reference: 'r' });
    expect(unknown.outcome).toBe('unknown');
    expect((await rail.getPayoutStatus(unknown.payoutReference!)).outcome).toBe('paid');

    const noRef = await rail.transfer({ destinationToken: token, idempotencyKey: 'n', amountMinorUnits: amount(SANDBOX_PAYOUT_UNKNOWN_NO_REFERENCE_SUFFIX), currencyCode: 'PKR', reference: 'r' });
    expect(noRef).toEqual({ outcome: 'unknown', payoutReference: null });
    expect((await rail.getPayoutStatusByIdempotencyKey('n')).outcome).toBe('paid');
  });

  it('a key the rail never received is authoritatively transfer_not_received', async () => {
    expect(await rail.getPayoutStatusByIdempotencyKey('never-sent')).toEqual({
      outcome: 'failed',
      payoutReference: null,
      failureCode: 'transfer_not_received',
    });
  });

  it('a revoked destination can never be paid again', async () => {
    const token = await destination();
    await rail.revokeDestination(token);
    const result = await rail.transfer({ destinationToken: token, idempotencyKey: 'after-revoke', amountMinorUnits: amount(0), currencyCode: 'PKR', reference: 'r' });
    expect(result.outcome).toBe('failed');
    expect(result.failureCode).toBe('destination_invalid');
  });
});
