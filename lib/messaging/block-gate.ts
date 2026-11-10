/**
 * Spec 025 §3 "Blocking" (AC-6) — spec 030 owns blocking mechanics.
 *
 * `user_blocks` does not exist and spec 030 has not shipped, so this spec ships a PORT with an inert
 * default — the idiom spec 020 used for `CompletionEvidenceGate` and spec 022 for
 * `RefundEligibilityGate`. Spec 030 registers the real gate at startup; nothing else here changes.
 *
 * The gate affects SENDING only. Reads, read markers and admin access are never consulted against it:
 * master spec §53 keeps existing-booking communication reachable for safety and support.
 */
import type { Executor } from '@/lib/offers/db';

export interface ConversationBlockStatus {
  blocked: boolean;
  /** Which direction, for the sender-facing message. Opaque to this spec. */
  reason?: 'blocked_by_counterparty' | 'blocked_counterparty';
}

/** `a` is the sender, `b` the counterparty. A block in EITHER direction must report `blocked`. */
export type ConversationBlockGate = (tx: Executor, a: string, b: string) => Promise<ConversationBlockStatus>;

/** The pre-spec-030 default: with no blocking feature, nobody is blocked. */
const NOT_BLOCKED: ConversationBlockGate = async () => ({ blocked: false });

let currentGate: ConversationBlockGate = NOT_BLOCKED;

/** Called once by spec 030 at startup to make the gate real. */
export function registerConversationBlockGate(gate: ConversationBlockGate): void {
  currentGate = gate;
}

export function getConversationBlockGate(): ConversationBlockGate {
  return currentGate;
}

/** Test-only: restores the inert default so suites cannot leak into each other. */
export function resetConversationBlockGate(): void {
  currentGate = NOT_BLOCKED;
}

/**
 * Consults the registered gate. A gate that THROWS is treated as not-blocked and logged: a failure in
 * an unshipped safety dependency must never silently sever a live booking's coordination channel.
 */
export async function checkConversationBlock(
  tx: Executor,
  senderUserId: string,
  counterpartyUserId: string,
  conversationId: string,
): Promise<ConversationBlockStatus> {
  try {
    return await getConversationBlockGate()(tx, senderUserId, counterpartyUserId);
  } catch (err) {
    console.error(JSON.stringify({ event: 'messaging.block_gate_failed', conversationId, error: String(err) }));
    return { blocked: false };
  }
}
