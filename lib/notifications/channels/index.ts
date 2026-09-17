/**
 * Spec 026 §3 — channel adapter selection, and AC-10's production guard. The same shape as spec 021's
 * `lib/payments/provider/index.ts` — copied, not shared.
 *
 * Selection is `process.env.NOTIFICATION_CHANNEL_PROVIDER` (default `sandbox`): an environment variable,
 * not a feature flag (spec 041). Two refusals, both hard:
 *   - an unknown value throws — no silent fallback to the sandbox because a variable was mistyped;
 *   - a sandbox adapter under `NODE_ENV=production` throws.
 * A provider may supply only some channels; a channel it lacks is recorded `skipped` / `no_adapter`.
 */
import type { OutboundChannel } from '@/lib/types/notifications';
import { getSandboxChannelAdapters } from './sandbox';
import type { NotificationChannelAdapter } from './types';

export type { ChannelDeliveryInput, ChannelOutcome, ChannelResult, NotificationChannelAdapter } from './types';
export {
  getSandboxChannelAdapters,
  getSandboxChannelRecords,
  resetSandboxChannelRecords,
  SANDBOX_NOTIFICATION_REFERENCE_PREFIX,
} from './sandbox';

export const NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR = 'NOTIFICATION_CHANNEL_PROVIDER';
const DEFAULT_PROVIDER = 'sandbox';

export type ChannelAdapterSet = Partial<Record<OutboundChannel, NotificationChannelAdapter>>;

/** The adapter providers this repository actually has. A real vendor registers its name here. */
const PROVIDERS: Record<string, () => ChannelAdapterSet> = {
  sandbox: getSandboxChannelAdapters,
};

export class NotificationChannelProviderUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationChannelProviderUnavailable';
  }
}

/** Read fresh on every call: a cached set would let whichever call warmed it bypass AC-10's guard. */
export function resolveNotificationChannelAdapters(): ChannelAdapterSet {
  const configured = (process.env.NOTIFICATION_CHANNEL_PROVIDER ?? '').trim() || DEFAULT_PROVIDER;
  const factory = PROVIDERS[configured];
  if (!factory) {
    throw new NotificationChannelProviderUnavailable(
      `${NOTIFICATION_CHANNEL_PROVIDER_ENV_VAR}="${configured}" is not a known notification channel provider.`,
    );
  }
  const adapters = factory();
  if (process.env.NODE_ENV === 'production' && Object.values(adapters).some((adapter) => adapter?.isSandbox)) {
    throw new NotificationChannelProviderUnavailable(
      `The "${configured}" notification channel provider is a sandbox and must never run in production. Configure a real provider.`,
    );
  }
  return adapters;
}
