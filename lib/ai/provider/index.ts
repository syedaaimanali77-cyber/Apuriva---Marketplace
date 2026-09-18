/**
 * Spec 033 §3.4 — configuration-driven provider selection, and AC-2's two refusals. The same shape
 * as spec 021's `lib/payments/provider/index.ts` and spec 026's `lib/notifications/channels/index.ts`
 * — copied, not shared.
 *
 * Selection is `process.env.AI_PROVIDER` (default `sandbox`): an environment variable, not a
 * feature flag (spec 041). Two refusals, both hard:
 *   - an unknown value throws — NO silent fallback to the sandbox because a variable was mistyped;
 *   - a sandbox adapter under `NODE_ENV=production` throws, so production can never serve mock
 *     completions.
 *
 * Adding a real provider is one new file in this directory plus one line in `PROVIDERS`. No
 * consuming module changes — that is exactly what AC-2 asserts.
 */
import { AiProviderConfigurationError } from '../errors';
import { getSandboxAiProvider } from './sandbox';
import type { AiProviderAdapter } from './types';

export type { AiProviderAdapter, AiProviderCompletion } from './types';
export { getSandboxAiProvider, extractSearchIntent, SANDBOX_AI_OUTPUT_PREFIX } from './sandbox';

export const AI_PROVIDER_ENV_VAR = 'AI_PROVIDER';
const DEFAULT_PROVIDER = 'sandbox';

/** The adapter providers this repository actually has. A real vendor registers its name here. */
const PROVIDERS: Record<string, () => AiProviderAdapter> = {
  sandbox: getSandboxAiProvider,
};

/** Every registered adapter name, for the admin/diagnostic surfaces that need to list them. */
export function registeredAiProviderNames(): string[] {
  return Object.keys(PROVIDERS);
}

/**
 * Read fresh on every call: a cached adapter would let whichever call warmed it bypass the
 * production guard below.
 */
export function resolveAiProvider(): AiProviderAdapter {
  const configured = (process.env.AI_PROVIDER ?? '').trim() || DEFAULT_PROVIDER;
  const factory = PROVIDERS[configured];
  if (!factory) {
    throw new AiProviderConfigurationError(
      `${AI_PROVIDER_ENV_VAR}="${configured}" is not a known AI provider. Registered: ${registeredAiProviderNames().join(', ')}.`,
    );
  }
  const adapter = factory();
  if (process.env.NODE_ENV === 'production' && adapter.isSandbox) {
    throw new AiProviderConfigurationError(
      `The "${configured}" AI provider is a sandbox and must never run in production. Configure a real provider.`,
    );
  }
  return adapter;
}
