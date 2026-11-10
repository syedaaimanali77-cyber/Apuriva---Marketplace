/**
 * Spec 026 §3 "Channels and the adapter seam" (AC-10).
 *
 * This repository has no push, SMS or email infrastructure of any kind, so this spec ships the SEAM and
 * a sandbox — no vendor. `in_app` is not an adapter: it is the `notifications` row itself.
 */
import type { NotificationChannel } from '@/lib/types/notifications';

export type { NotificationChannel };

export interface ChannelDeliveryInput {
  notificationId: string;
  channel: Exclude<NotificationChannel, 'in_app'>;
  recipientUserId: string;
  title: string;
  body: string;
}

/** `'unknown'` is never collapsed into `'failed'` — spec 021/022's rule, for the same reason. */
export type ChannelOutcome = 'delivered' | 'failed' | 'unknown';

export interface ChannelResult {
  outcome: ChannelOutcome;
  providerReference: string | null;
  failureCode?: string;
}

export interface NotificationChannelAdapter {
  readonly channel: Exclude<NotificationChannel, 'in_app'>;
  /** `true` only for the sandbox — the factory refuses it under `NODE_ENV=production` (AC-10). */
  readonly isSandbox?: boolean;
  deliver(input: ChannelDeliveryInput): Promise<ChannelResult>;
}
