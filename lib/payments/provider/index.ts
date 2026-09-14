/**
 * Spec 021 §3 "Payment-provider architecture" — adapter selection, and AC-10's production guard.
 *
 * Selection is `process.env.PAYMENT_PROVIDER`, an environment variable per master spec §133.6 —
 * deliberately NOT a feature-flag system (spec 041 owns runtime configuration), and handled exactly
 * the way `SEARCH_NL_INTERPRETATION_ENABLED` and `HOME_PERSONALIZATION_ENABLED` already are.
 *
 * Two refusals, both hard:
 *   - an unknown or absent value throws. There is no silent fallback, because falling back to a
 *     sandbox because a variable was mistyped is precisely how a fabricated success reaches
 *     production.
 *   - a sandbox adapter under `NODE_ENV=production` throws (AC-10). A production deployment
 *     without a real adapter refuses to take payments rather than pretending one succeeded
 *     (master spec §132.21, §132.22, §133.5).
 */
import { getSandboxPaymentProvider } from './sandbox';
import type { PaymentProvider } from './types';

export type { AuthorizeInput, CaptureInput, PaymentProvider, ProviderOutcome, ProviderResult, VoidInput } from './types';
export { getSandboxPaymentProvider, SANDBOX_DECLINE_AMOUNT_SUFFIX, SANDBOX_REFERENCE_PREFIX, SANDBOX_REQUIRES_ACTION_AMOUNT_SUFFIX } from './sandbox';

export const PAYMENT_PROVIDER_ENV_VAR = 'PAYMENT_PROVIDER';

/** The adapters this repository actually has. A real vendor adds its name here and nowhere else. */
const ADAPTERS: Record<string, () => PaymentProvider> = {
  sandbox: getSandboxPaymentProvider,
};

export class PaymentProviderUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentProviderUnavailable';
  }
}

/**
 * Resolves the configured adapter, or throws `PaymentProviderUnavailable` — which every payment
 * route maps to `503 PAYMENT_PROVIDER_UNAVAILABLE`.
 *
 * Read fresh on every call rather than memoized: tests flip `PAYMENT_PROVIDER` and `NODE_ENV`, and
 * a cached provider would make AC-10's guard untestable and, worse, bypassable by whichever request
 * warmed the cache first.
 */
export function resolvePaymentProvider(): PaymentProvider {
  const configured = (process.env[PAYMENT_PROVIDER_ENV_VAR] ?? '').trim();
  if (configured.length === 0) {
    throw new PaymentProviderUnavailable(`${PAYMENT_PROVIDER_ENV_VAR} is not set; no payment adapter is configured.`);
  }

  const factory = ADAPTERS[configured];
  if (!factory) {
    throw new PaymentProviderUnavailable(`${PAYMENT_PROVIDER_ENV_VAR}="${configured}" is not a known payment adapter.`);
  }

  const provider = factory();
  if (provider.isSandbox && process.env.NODE_ENV === 'production') {
    // AC-10. The sandbox exists so development and tests have a seam, never so production can
    // report a payment nobody made.
    throw new PaymentProviderUnavailable(
      `The "${provider.name}" adapter is a sandbox and must never run in production. Configure a real payment provider.`,
    );
  }
  return provider;
}
