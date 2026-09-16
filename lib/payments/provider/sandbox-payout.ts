/**
 * Spec 024 §3.2 — the sandbox payout adapter.
 *
 * This repository has no Pakistan payout-rail account, credentials or vendor sandbox. Master spec
 * §133.5 forbids inventing external credentials and §133.7 requires a sandbox when they are
 * unavailable, so that is exactly what this is. It moves no money, contacts no network, and touches
 * no database table (spec 021's `no-fabricated-success.test.ts` scans this directory).
 *
 * Simulated behaviour can never be mistaken for a real transfer:
 *   - `isSandbox` is `true`, and `resolvePayoutProvider()` refuses it under `NODE_ENV=production`;
 *   - every reference and destination token it issues is prefixed `sandbox_payout_`;
 *   - `name` is `'sandbox'`, persisted on every `payouts` and `payout_methods` row it produces.
 *
 * Outcomes are deterministic by the LAST FOUR digits of the transfer amount, the same idiom spec 021's
 * payment sandbox uses, so every AC-5/AC-7 path is reachable in a test.
 */
import { randomUUID } from 'node:crypto';
import type { PayoutFailureCode } from '@/lib/types/payouts';
import type { PayoutProvider, PayoutResult, PayoutTransferInput, RegisteredDestination } from './payout-types';

export const SANDBOX_PAYOUT_PREFIX = 'sandbox_payout_';

/** Definitive failure: the destination is invalid. */
export const SANDBOX_PAYOUT_DESTINATION_INVALID_SUFFIX = 3101;
/** Definitive failure: the rail rejected the transfer. Never retried automatically. */
export const SANDBOX_PAYOUT_REJECTED_SUFFIX = 3102;
/** Ambiguous: the rail DID pay, but the caller never learns it from this call. */
export const SANDBOX_PAYOUT_UNKNOWN_SUFFIX = 3103;
/** Definitive failure: the rail is temporarily unavailable. Retried automatically after backoff. */
export const SANDBOX_PAYOUT_TEMPORARILY_UNAVAILABLE_SUFFIX = 3104;
/** Ambiguous with NO reference: the rail paid, but returned no handle. Resolvable only by key. */
export const SANDBOX_PAYOUT_UNKNOWN_NO_REFERENCE_SUFFIX = 3105;
/** Definitive failure: the destination is temporarily unavailable. */
export const SANDBOX_PAYOUT_DESTINATION_UNAVAILABLE_SUFFIX = 3106;

/**
 * The sandbox setup-token format, standing in for what a real rail's hosted onboarding UI returns:
 * `sandbox_setup:<bank|mobile_wallet>:<last four digits>:<ISO currency>`. Only the last four digits
 * ever exist — there is no field for a full account number, even in the sandbox.
 */
export const SANDBOX_SETUP_TOKEN_PATTERN = /^sandbox_setup:(bank|mobile_wallet):(\d{4}):([A-Z]{3})$/;

export function sandboxSetupToken(type: 'bank' | 'mobile_wallet' = 'bank', lastFour = '1234', currencyCode = 'PKR'): string {
  return `sandbox_setup:${type}:${lastFour}:${currencyCode}`;
}

const DEFINITIVE_FAILURES: Record<number, PayoutFailureCode> = {
  [SANDBOX_PAYOUT_DESTINATION_INVALID_SUFFIX]: 'destination_invalid',
  [SANDBOX_PAYOUT_REJECTED_SUFFIX]: 'transfer_rejected',
  [SANDBOX_PAYOUT_TEMPORARILY_UNAVAILABLE_SUFFIX]: 'rail_temporarily_unavailable',
  [SANDBOX_PAYOUT_DESTINATION_UNAVAILABLE_SUFFIX]: 'destination_unavailable',
};

class SandboxPayoutProvider implements PayoutProvider {
  readonly name = 'sandbox';
  readonly isSandbox = true;

  private consumedSetupTokens = new Set<string>();
  private destinations = new Set<string>();
  private revoked = new Set<string>();
  /** Rail-side idempotency: one key ⇒ one DEFINITIVE result, replayed verbatim. */
  private byIdempotencyKey = new Map<string, PayoutResult>();
  private byReference = new Map<string, PayoutResult>();
  private unresolvableReferences = new Set<string>();
  private failNextRevocation = false;
  private transferCalls: PayoutTransferInput[] = [];

  async registerDestination(setupToken: string): Promise<RegisteredDestination | null> {
    const match = SANDBOX_SETUP_TOKEN_PATTERN.exec(setupToken);
    if (!match || this.consumedSetupTokens.has(setupToken)) return null;
    this.consumedSetupTokens.add(setupToken);

    const [, type, lastFour, currencyCode] = match as unknown as [string, 'bank' | 'mobile_wallet', string, string];
    const destinationToken = `${SANDBOX_PAYOUT_PREFIX}dest_${randomUUID()}`;
    this.destinations.add(destinationToken);
    return {
      destinationToken,
      type,
      maskedDetail: `****${lastFour}`,
      institutionLabel: type === 'bank' ? 'Sandbox Bank' : 'Sandbox Wallet',
      payoutCurrencyCode: currencyCode,
    };
  }

  async revokeDestination(destinationToken: string): Promise<void> {
    if (this.failNextRevocation) {
      this.failNextRevocation = false;
      throw new Error('Sandbox revocation outage by design.');
    }
    this.revoked.add(destinationToken);
  }

  async transfer(input: PayoutTransferInput): Promise<PayoutResult> {
    this.transferCalls.push(input);
    const replay = this.byIdempotencyKey.get(input.idempotencyKey);
    if (replay) return replay.outcome === 'unknown' ? replay : { ...replay };

    if (!this.destinations.has(input.destinationToken) || this.revoked.has(input.destinationToken)) {
      const failed: PayoutResult = {
        outcome: 'failed',
        payoutReference: `${SANDBOX_PAYOUT_PREFIX}${randomUUID()}`,
        failureCode: 'destination_invalid',
        failureMessage: 'Sandbox has no live destination for that token.',
      };
      this.remember(input.idempotencyKey, failed);
      return failed;
    }

    const suffix = Math.abs(input.amountMinorUnits) % 10_000;
    const reference = `${SANDBOX_PAYOUT_PREFIX}${randomUUID()}`;

    const failureCode = DEFINITIVE_FAILURES[suffix];
    if (failureCode) {
      const failed: PayoutResult = {
        outcome: 'failed',
        payoutReference: reference,
        failureCode,
        failureMessage: 'Sandbox failed this transfer amount by design.',
      };
      this.remember(input.idempotencyKey, failed);
      return failed;
    }

    const paid: PayoutResult = { outcome: 'paid', payoutReference: reference };
    // The ambiguous cases DO record the transfer as paid on the rail side — exactly the dangerous
    // real-world shape: the money moved, the caller never learned it. A read must find the truth.
    this.remember(input.idempotencyKey, paid);
    if (suffix === SANDBOX_PAYOUT_UNKNOWN_SUFFIX) return { outcome: 'unknown', payoutReference: reference };
    if (suffix === SANDBOX_PAYOUT_UNKNOWN_NO_REFERENCE_SUFFIX) return { outcome: 'unknown', payoutReference: null };
    return paid;
  }

  async getPayoutStatus(payoutReference: string): Promise<PayoutResult> {
    if (this.unresolvableReferences.has(payoutReference)) return { outcome: 'unknown', payoutReference };
    return this.byReference.get(payoutReference) ?? { outcome: 'unknown', payoutReference };
  }

  /**
   * The sandbox IS the rail, so its key lookup is authoritative: a key it never received was never
   * transferred, which is the one case `transfer_not_received` may be reported.
   */
  async getPayoutStatusByIdempotencyKey(idempotencyKey: string): Promise<PayoutResult> {
    const known = this.byIdempotencyKey.get(idempotencyKey);
    if (known) {
      if (known.payoutReference && this.unresolvableReferences.has(known.payoutReference)) {
        return { outcome: 'unknown', payoutReference: known.payoutReference };
      }
      return known;
    }
    return { outcome: 'failed', payoutReference: null, failureCode: 'transfer_not_received' };
  }

  private remember(key: string, result: PayoutResult): void {
    this.byIdempotencyKey.set(key, result);
    if (result.payoutReference) this.byReference.set(result.payoutReference, result);
  }

  /** Test-only: keeps every read for this reference ambiguous. */
  markUnresolvable(payoutReference: string): void {
    this.unresolvableReferences.add(payoutReference);
  }

  /** Test-only: the next `revokeDestination` throws, simulating a rail outage. */
  failNextRevocationOnce(): void {
    this.failNextRevocation = true;
  }

  /** Test-only: every `transfer` call made, so suites can prove no duplicate transfer was issued. */
  transfers(): readonly PayoutTransferInput[] {
    return this.transferCalls;
  }

  isRevoked(destinationToken: string): boolean {
    return this.revoked.has(destinationToken);
  }

  reset(): void {
    this.consumedSetupTokens.clear();
    this.destinations.clear();
    this.revoked.clear();
    this.byIdempotencyKey.clear();
    this.byReference.clear();
    this.unresolvableReferences.clear();
    this.failNextRevocation = false;
    this.transferCalls = [];
  }
}

const instance = new SandboxPayoutProvider();

export function getSandboxPayoutProvider(): SandboxPayoutProvider {
  return instance;
}
