/**
 * Spec 021 §3 "Payment-provider architecture" — the vendor seam.
 *
 * `lib/payments/provider/` is the ONLY directory permitted to hold payment-provider credentials or
 * to import a vendor SDK. Everything else in the application talks to this interface, so adopting a
 * real Pakistan provider later is a new file implementing `PaymentProvider` plus one entry in
 * `resolvePaymentProvider()` — not a rewrite of any call site. This is the same swappable-adapter
 * idiom `lib/auth/sms-otp-provider.ts` already ships for SMS (spec 005 §8 risk #1).
 *
 * The primitives mirror the ones master spec §46 names — authorization, hold/capture, void and a
 * status read for reconciliation — and nothing more. In particular there is NO parameter anywhere
 * in this file that could carry a card number, CVV, expiry or wallet credential: a payment
 * instrument is collected by the provider's own hosted/embedded UI and never transits an Apuriva
 * route or column (master spec §48, §4 "Retention and privacy").
 */

/** What the provider actually reported. Application code never widens or infers this. */
export type ProviderOutcome = 'authorized' | 'captured' | 'requires_action' | 'failed';

export interface ProviderResult {
  outcome: ProviderOutcome;
  /**
   * The provider's own opaque handle for this payment. Stored server-side for reconciliation and
   * NEVER serialized into a DTO, a log line or a privacy export (§4 "Retention and privacy").
   */
  providerReference: string;
  /** A stable machine code, safe to echo in `details.failureCode`. Never a raw vendor payload. */
  failureCode?: string;
  /** Operator-facing detail. Never rendered to the customer — the UI uses master spec §105's copy. */
  failureMessage?: string;
  /** Set only for `requires_action`: the KIND of step-up, never a credential or redirect secret. */
  actionKind?: string;
}

interface MoneyInput {
  amountMinorUnits: number;
  currencyCode: string;
}

export interface AuthorizeInput extends MoneyInput {
  /**
   * Forwarded to the provider as ITS idempotency key, so a retry that somehow reached the provider
   * twice is deduplicated there as well as in this application (§3 "Idempotency and concurrency" —
   * both levels, not one).
   */
  idempotencyKey: string;
  /** Opaque correlation for provider-side support. Carries no personal data. */
  reference: string;
}

export interface CaptureInput extends MoneyInput {
  idempotencyKey: string;
  providerReference: string;
}

export interface VoidInput {
  idempotencyKey: string;
  providerReference: string;
}

/**
 * Spec 022 §3 "Provider seam extension" — the refund primitives, ADDED to this interface rather
 * than given a parallel abstraction of their own, so refunds keep one payment adapter and one
 * credential boundary.
 *
 * `'unknown'` is the load-bearing value and the reason this is its own union rather than a reuse of
 * `ProviderOutcome`: a timeout, a dropped connection or an unrecognised provider response maps to
 * `unknown`, and spec 022 AC-7 forbids collapsing it into `'failed'`. Claiming a refund failed when
 * the provider may in fact have executed it is the same class of error as claiming a payment
 * succeeded when it did not (master spec §132.7), and it strands the customer's money.
 */
export type ProviderRefundOutcome = 'refunded' | 'failed' | 'unknown';

export interface RefundInput extends MoneyInput {
  /** Forwarded to the provider as ITS idempotency key, so both levels deduplicate. */
  idempotencyKey: string;
  /** The authorization/capture handle spec 021 stored on the payment. */
  providerReference: string;
}

export interface ProviderRefundResult {
  outcome: ProviderRefundOutcome;
  /**
   * The provider's own handle for THIS refund, distinct from the payment's reference. `null` when
   * the provider never got far enough to issue one (spec 022 §3 "Provider ambiguity"). Stored
   * server-side only and never serialized into a DTO, a log line or a privacy export.
   */
  refundReference: string | null;
  failureCode?: string;
  failureMessage?: string;
}

export interface PaymentProvider {
  /** Stored on `payments.provider_name` so a row always records which adapter produced it. */
  readonly name: string;
  /**
   * True for any adapter that does not move real money. `resolvePaymentProvider()` refuses to hand
   * one back under `NODE_ENV=production` (AC-10), which is what makes shipping a sandbox safe: a
   * production deployment without a real adapter refuses payments instead of fabricating success.
   */
  readonly isSandbox: boolean;
  authorize(input: AuthorizeInput): Promise<ProviderResult>;
  capture(input: CaptureInput): Promise<ProviderResult>;
  voidAuthorization(input: VoidInput): Promise<ProviderResult>;
  /** Reconciliation read — the escape hatch for a crash between the call and recording it. */
  getStatus(providerReference: string): Promise<ProviderResult>;
  /** Spec 022: executes a full or partial refund against a captured payment. */
  refund(input: RefundInput): Promise<ProviderRefundResult>;
  /**
   * Spec 022 AC-7's recovery path. A READ, never a second `refund()` call — which is precisely what
   * makes resolving an ambiguous outcome incapable of refunding twice.
   */
  getRefundStatus(refundReference: string): Promise<ProviderRefundResult>;
}
