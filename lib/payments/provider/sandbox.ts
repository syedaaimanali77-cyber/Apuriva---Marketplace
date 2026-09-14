/**
 * Spec 021 §3 "Payment-provider architecture" — the sandbox adapter.
 *
 * WHY THIS EXISTS, STATED PLAINLY: this repository has no Pakistan payment-provider account, no
 * credentials and no sandbox access. Master spec §133.5 forbids inventing external credentials and
 * §133.7 requires a sandbox/mock adapter when they are unavailable, so that is exactly what this
 * is — and nothing more. It moves no money, contacts no network, and claims no vendor relationship.
 *
 * It is designed so that simulated behaviour can never be mistaken for a real confirmation:
 *   - `isSandbox` is `true`, and `resolvePaymentProvider()` refuses to return it under
 *     `NODE_ENV=production` (AC-10);
 *   - every reference it issues is prefixed `sandbox_`, so a stored reference is self-describing
 *     in the database, in logs and in any operator tooling;
 *   - `name` is `'sandbox'`, persisted on every `payments` row it produces.
 *
 * It mirrors the parts of real provider semantics the application depends on — idempotency keys,
 * the four outcomes, and a status read — so swapping in a real adapter exercises the same code
 * paths rather than revealing untested ones.
 */
import { randomUUID } from 'node:crypto';
import type {
  AuthorizeInput,
  CaptureInput,
  PaymentProvider,
  ProviderResult,
  VoidInput,
} from './types';

/**
 * Deterministic test amounts, chosen the way real providers publish magic test values.
 *
 * They are matched on the LAST FOUR digits of the minor-unit amount, so a test can pick any
 * realistic price and still steer the outcome. Every other amount authorizes normally.
 */
export const SANDBOX_DECLINE_AMOUNT_SUFFIX = 1102;
export const SANDBOX_REQUIRES_ACTION_AMOUNT_SUFFIX = 1103;

export const SANDBOX_REFERENCE_PREFIX = 'sandbox_';

interface SandboxRecord {
  reference: string;
  outcome: ProviderResult['outcome'];
  amountMinorUnits: number;
  currencyCode: string;
}

function outcomeForAmount(amountMinorUnits: number): ProviderResult['outcome'] {
  const suffix = Math.abs(amountMinorUnits) % 10_000;
  if (suffix === SANDBOX_DECLINE_AMOUNT_SUFFIX) return 'failed';
  if (suffix === SANDBOX_REQUIRES_ACTION_AMOUNT_SUFFIX) return 'requires_action';
  return 'authorized';
}

/**
 * A non-production adapter. In-memory only: it is deliberately NOT durable, because pretending to
 * be a durable ledger would be the "fake working integration" master spec §132.21 forbids. The
 * application's own `payments` table is the durable record; this is only the far side of the seam.
 */
class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox';
  readonly isSandbox = true;

  /** Provider-side idempotency: one key ⇒ one result, replayed verbatim (AC-7). */
  private byIdempotencyKey = new Map<string, ProviderResult>();
  private byReference = new Map<string, SandboxRecord>();

  async authorize(input: AuthorizeInput): Promise<ProviderResult> {
    const replay = this.byIdempotencyKey.get(input.idempotencyKey);
    if (replay) return replay;

    const reference = `${SANDBOX_REFERENCE_PREFIX}${randomUUID()}`;
    const outcome = outcomeForAmount(input.amountMinorUnits);

    const result: ProviderResult =
      outcome === 'failed'
        ? {
            outcome,
            providerReference: reference,
            failureCode: 'card_declined',
            failureMessage: 'Sandbox declined this amount by design.',
          }
        : outcome === 'requires_action'
          ? { outcome, providerReference: reference, actionKind: 'three_d_secure' }
          : { outcome, providerReference: reference };

    this.byIdempotencyKey.set(input.idempotencyKey, result);
    this.byReference.set(reference, {
      reference,
      outcome,
      amountMinorUnits: input.amountMinorUnits,
      currencyCode: input.currencyCode,
    });
    return result;
  }

  async capture(input: CaptureInput): Promise<ProviderResult> {
    const replay = this.byIdempotencyKey.get(input.idempotencyKey);
    if (replay) return replay;

    const record = this.byReference.get(input.providerReference);
    if (!record) {
      // An unknown reference is a genuine provider-side failure, not an application assumption.
      return {
        outcome: 'failed',
        providerReference: input.providerReference,
        failureCode: 'unknown_reference',
        failureMessage: 'Sandbox has no authorization for that reference.',
      };
    }
    if (input.amountMinorUnits > record.amountMinorUnits) {
      return {
        outcome: 'failed',
        providerReference: record.reference,
        failureCode: 'capture_exceeds_authorization',
        failureMessage: 'Sandbox refuses a capture larger than its authorization.',
      };
    }

    const result: ProviderResult = { outcome: 'captured', providerReference: record.reference };
    record.outcome = 'captured';
    this.byIdempotencyKey.set(input.idempotencyKey, result);
    return result;
  }

  async voidAuthorization(input: VoidInput): Promise<ProviderResult> {
    const record = this.byReference.get(input.providerReference);
    if (!record) {
      return {
        outcome: 'failed',
        providerReference: input.providerReference,
        failureCode: 'unknown_reference',
      };
    }
    record.outcome = 'failed';
    return { outcome: 'failed', providerReference: record.reference, failureCode: 'voided' };
  }

  async getStatus(providerReference: string): Promise<ProviderResult> {
    const record = this.byReference.get(providerReference);
    if (!record) {
      return { outcome: 'failed', providerReference, failureCode: 'unknown_reference' };
    }
    return { outcome: record.outcome, providerReference: record.reference };
  }

  /** Test-only: clears captured state so suites do not leak into each other. */
  reset(): void {
    this.byIdempotencyKey.clear();
    this.byReference.clear();
  }
}

const instance = new SandboxPaymentProvider();

export function getSandboxPaymentProvider(): SandboxPaymentProvider {
  return instance;
}
