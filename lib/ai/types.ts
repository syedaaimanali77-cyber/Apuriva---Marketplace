/**
 * Spec 033 §3.3 — the stable internal contract every AI-consuming module is written against.
 * Nothing here names a vendor: swapping providers is an `AI_PROVIDER` change, not a code change
 * (AC-2), and no consumer can learn which provider answered it (AC-1).
 */
import type { AiTask } from '@/lib/types/ai';

/** Re-exported, not re-derived: `lib/types/ai.ts` owns the union, the way `lib/types/bookings.ts`
 *  owns `BookingStatus`. Domain code keeps importing it from `lib/ai`. */
export type { AiTask };

/**
 * Who the call is attributed to, for rate limiting, quota and abuse accounting.
 *
 * A `guest` carries the existing `hashRequestIp()` digest (lib/auth/ip-hash.ts), never a raw IP.
 * A `system` subject is a platform-initiated call with no end user behind it: it is rate-limited,
 * accounted and cost-monitored like any other subject, but not quota-capped (spec 033 §3.7) —
 * there is no user to protect and no route through which it can be driven.
 */
export type AiSubject =
  | { kind: 'user'; userId: string }
  | { kind: 'guest'; ipHash: string }
  | { kind: 'system'; label: string };

export interface AiCompletionRequest {
  task: AiTask;
  input: string;
  subject: AiSubject;
  /** Clamped DOWN to `AI_MAX_TOKENS_PER_REQUEST`; never up. */
  maxTokens?: number;
}

/**
 * Deliberately carries no `provider`/`model` field. The vendor identity never leaves `lib/ai`, so
 * no consumer can accidentally serialise it to a customer (master spec §132.1/§132.12); it is
 * recorded in `ai_usage_events` and surfaced only to admins through `AiUsageSummaryDto`.
 */
export interface AiCompletionResult {
  output: string;
  tokensUsed: number;
  cached: boolean;
}

/** The stable key a subject is rate-limited and quota-counted under. */
export function subjectKey(subject: AiSubject): string {
  switch (subject.kind) {
    case 'user':
      return `user:${subject.userId}`;
    case 'guest':
      return `guest:${subject.ipHash}`;
    case 'system':
      return `system:${subject.label}`;
  }
}
