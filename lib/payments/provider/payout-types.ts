/**
 * Spec 024 §3.2 "Payout-rail seam" — the disbursement port.
 *
 * A second PORT inside spec 021's single credential boundary, not a second payment abstraction.
 * `PaymentProvider` models money coming IN from a customer's instrument (authorize, capture, void,
 * refund — a reversal on that same rail). A payout is money going OUT to a provider's registered
 * bank account or mobile wallet on a disbursement rail, which is routinely a different vendor with
 * different credentials, so it gets its own interface and its own selection variable.
 *
 * Adapters are PURE RAIL CLIENTS: they read and write no database table. Spec 021's
 * `lib/payments/no-fabricated-success.test.ts` scans every production file under `lib/payments/`,
 * and all payout persistence lives in `lib/payouts/**`.
 *
 * There is NO parameter anywhere in this file that could carry an account number, IBAN, wallet
 * number, PIN or CNIC. Details are collected by the rail's own hosted onboarding UI.
 */
import type { PayoutFailureCode } from '@/lib/types/payouts';

/** Mirrors spec 022's refund trichotomy. `unknown` is NEVER collapsed into `failed`. */
export type PayoutOutcome = 'paid' | 'failed' | 'unknown';

export interface PayoutTransferInput {
  /** The rail's opaque handle for a registered destination. Never an account number. */
  destinationToken: string;
  /** Forwarded as the RAIL's idempotency key. One key per payout ATTEMPT (§3.8). */
  idempotencyKey: string;
  amountMinorUnits: number;
  currencyCode: string;
  /** Opaque correlation for rail-side support. Carries no personal data. */
  reference: string;
}

export interface PayoutResult {
  outcome: PayoutOutcome;
  /** The rail's own handle for THIS transfer. Stored server-side, never serialized to a client. */
  payoutReference: string | null;
  /** A stable machine code from the closed §3.2 set. Never a raw rail payload. */
  failureCode?: PayoutFailureCode;
  /** Operator-facing detail. Never rendered to a provider. */
  failureMessage?: string;
}

/** What the rail returns after its own hosted onboarding UI has collected the details. */
export interface RegisteredDestination {
  destinationToken: string;
  type: 'bank' | 'mobile_wallet';
  /** Rail-supplied display mask, e.g. `****1234`. The ONLY detail this platform ever renders. */
  maskedDetail: string;
  /** Rail-supplied label, e.g. a bank or wallet brand. Never free text from the client. */
  institutionLabel: string;
  payoutCurrencyCode: string;
}

export interface PayoutProvider {
  /** Stored on `payouts.provider_name` / `payout_methods.provider_name`. */
  readonly name: string;
  readonly isSandbox: boolean;
  /**
   * Exchanges a single-use setup token from the rail's hosted UI for a stored destination. Resolves
   * `null` when the rail rejects the token or it was already consumed.
   */
  registerDestination(setupToken: string): Promise<RegisteredDestination | null>;
  /** Revokes a destination at the rail when a provider removes a payout method. */
  revokeDestination(destinationToken: string): Promise<void>;
  transfer(input: PayoutTransferInput): Promise<PayoutResult>;
  /** Reconciliation READ — the escape hatch for AC-7. Can never move money. */
  getPayoutStatus(payoutReference: string): Promise<PayoutResult>;
  /**
   * Reconciliation READ for an attempt that has no stored reference (a crash between claiming the
   * payout and calling `transfer`, or a rail that returned no handle). Mandatory: an adapter whose
   * rail cannot be queried by idempotency key cannot be adopted without revisiting spec 024.
   * Returns `failed` + `transfer_not_received` only when the rail's lookup is authoritative.
   */
  getPayoutStatusByIdempotencyKey(idempotencyKey: string): Promise<PayoutResult>;
}
