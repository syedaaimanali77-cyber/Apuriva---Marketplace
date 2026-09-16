/**
 * Spec 024 §3.2 — payout-rail selection, mirroring `resolvePaymentProvider()` exactly.
 *
 * `PAYOUT_PROVIDER` is read fresh on every call (never memoized). An absent or unknown value throws
 * with no silent fallback, and a sandbox adapter under `NODE_ENV=production` throws — so a
 * deployment without a real rail refuses payouts instead of reporting one nobody made
 * (master spec §132.21, §132.22, §133.5).
 */
import type { PayoutProvider } from './payout-types';
import { getSandboxPayoutProvider } from './sandbox-payout';

export const PAYOUT_PROVIDER_ENV_VAR = 'PAYOUT_PROVIDER';

/** The rails this repository actually has. A real vendor adds its name here and nowhere else. */
const ADAPTERS: Record<string, () => PayoutProvider> = {
  sandbox: getSandboxPayoutProvider,
};

export class PayoutProviderUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayoutProviderUnavailable';
  }
}

export function resolvePayoutProvider(): PayoutProvider {
  const configured = (process.env[PAYOUT_PROVIDER_ENV_VAR] ?? '').trim();
  if (configured.length === 0) {
    throw new PayoutProviderUnavailable(`${PAYOUT_PROVIDER_ENV_VAR} is not set; no payout rail is configured.`);
  }

  const factory = ADAPTERS[configured];
  if (!factory) {
    throw new PayoutProviderUnavailable(`${PAYOUT_PROVIDER_ENV_VAR}="${configured}" is not a known payout rail.`);
  }

  const provider = factory();
  if (provider.isSandbox && process.env.NODE_ENV === 'production') {
    throw new PayoutProviderUnavailable(
      `The "${provider.name}" payout rail is a sandbox and must never run in production. Configure a real payout rail.`,
    );
  }
  return provider;
}
