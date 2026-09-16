/**
 * Spec 024 §3.6 and §3.8 — the two ports this spec consults but does not own.
 *
 * Both use the inert-default idiom spec 021's `DisputeGate` and spec 022's sinks established:
 * `register…` / `get…` / `reset…`, with a default that is correct rather than a stub.
 *
 *   - `PayoutHoldGate` — spec 038 owns payout holds for fraud, abuse or safety. With no spec 038,
 *     nothing is held. This spec invents no hold rule.
 *   - `PayoutNotificationSink` — spec 026 owns delivery. The default logs a structured line.
 *     Emission is fire-and-forget AFTER commit; a throwing sink never affects a payout.
 */
import type { Executor } from '@/lib/offers/db';
import type { PayoutFailureCode } from '@/lib/types/payouts';

export type PayoutHoldGate = (tx: Executor, providerProfileId: string) => Promise<{ held: boolean }>;

const NO_HOLDS: PayoutHoldGate = async () => ({ held: false });
let currentHoldGate: PayoutHoldGate = NO_HOLDS;

/** Called once by spec 038 at startup to make the gate real. */
export function registerPayoutHoldGate(gate: PayoutHoldGate): void {
  currentHoldGate = gate;
}

export function getPayoutHoldGate(): PayoutHoldGate {
  return currentHoldGate;
}

export function resetPayoutHoldGate(): void {
  currentHoldGate = NO_HOLDS;
}

export type PayoutNotificationEvent =
  | { kind: 'payout_paid'; payoutId: string; providerProfileId: string }
  | { kind: 'payout_failed'; payoutId: string; providerProfileId: string; failureCode: PayoutFailureCode; audience: 'provider' | 'finance' }
  | { kind: 'payout_escalated'; payoutId: string; audience: 'finance' };

export type PayoutNotificationSink = (event: PayoutNotificationEvent) => Promise<void>;

const LOG_ONLY: PayoutNotificationSink = async (event) => {
  console.log(JSON.stringify({ event: `payout_notification.${event.kind}`, ...event }));
};

let currentNotificationSink: PayoutNotificationSink = LOG_ONLY;

/** Called once by spec 026 at startup to make delivery real. */
export function registerPayoutNotificationSink(sink: PayoutNotificationSink): void {
  currentNotificationSink = sink;
}

export function getPayoutNotificationSink(): PayoutNotificationSink {
  return currentNotificationSink;
}

export function resetPayoutNotificationSink(): void {
  currentNotificationSink = LOG_ONLY;
}

/** After commit only. A notification failure must never affect a payout's financial state. */
export async function emitPayoutNotification(event: PayoutNotificationEvent): Promise<void> {
  try {
    await currentNotificationSink(event);
  } catch (err) {
    console.error(JSON.stringify({ event: 'payout_notification.sink_failed', kind: event.kind, error: String(err) }));
  }
}
