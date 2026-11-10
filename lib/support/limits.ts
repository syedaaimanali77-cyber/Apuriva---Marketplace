/**
 * Spec 032 §3 — the spec's bounded constants. PURE: no I/O, no database.
 *
 * No server-only import belongs in this file: the support UI imports these constants.
 */
import { MESSAGE_BODY_MAX_LENGTH } from '@/lib/messaging/limits';
import type { FileContextType } from '@/lib/types/files';
import type { SupportCategory, SupportPriority } from '@/lib/types/support';

/**
 * §3 "Categories and priority" (AC-4, DECIDED-4) — the ONLY place a ticket's initial priority comes
 * from, and the whole of it.
 *
 * WHY A CONSTANT MAP IS NOT THE THING SPEC 030 FORBIDS. Spec 030's DECIDED-1 says "nothing anywhere
 * derives a priority from a category" and `lib/safety/reports.ts` has no branch on its category —
 * that rule forbids inferring SEVERITY FROM CONTENT, i.e. reading someone's prose and claiming to
 * know how bad it is. This is a different thing: a declared constant map from a value the USER
 * THEMSELVES CHOSE, with no inference, no heuristic, no text analysis and no AI anywhere near it.
 * It is as deterministic as a default, and it is what makes AC-4 objectively testable — a `safety`
 * or `payment` ticket can never be created "at generic low priority".
 *
 * It never touches spec 030's own `safety_reports.priority`, which stays human-set through
 * `setSafetyPriority()`.
 */
export const CATEGORY_PRIORITY: Record<SupportCategory, SupportPriority> = {
  safety: 'critical',
  payment: 'high',
  booking: 'medium',
  provider_quality: 'medium',
  account: 'medium',
  technical: 'low',
  other: 'low',
};

/** AC-4's single entry point. Takes a category; takes nothing else, and reads no request body. */
export function priorityForCategory(category: SupportCategory): SupportPriority {
  return CATEGORY_PRIORITY[category];
}

/** §4 — prose bounds, mirrored by `support_tickets_subject_length_ck`. */
export const MIN_SUBJECT_LENGTH = 5;
export const MAX_SUBJECT_LENGTH = 200;

/** §4 — mirrored by `support_tickets_description_length_ck`. */
export const MIN_DESCRIPTION_LENGTH = 10;
export const MAX_DESCRIPTION_LENGTH = 4000;

/** §4 — admin reason bounds. Master §70 requires a reason on every recorded decision. */
export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 2000;

/**
 * Message and note bodies reuse spec 025's bound rather than inventing a second platform prose
 * bound — the rule specs 029/030/031 all followed.
 */
export const MAX_SUPPORT_BODY_LENGTH = MESSAGE_BODY_MAX_LENGTH;

/**
 * The assistant question's bound, also spec 025's value for the same reason. A question is user
 * prose in a chat-shaped box, so it gets the chat-shaped bound rather than the ticket
 * description's.
 */
export const MAX_ASSISTANT_QUESTION_LENGTH = MESSAGE_BODY_MAX_LENGTH;

/**
 * §3 "Messages" — the per-ticket message cap across ALL authors.
 *
 * 200, matching `MAX_DISPUTE_MESSAGES` for the same reason: it bounds the thread without
 * truncating a real exchange, so hitting it is a signal something has gone wrong rather than a
 * limit a good-faith conversation will meet.
 */
export const MAX_SUPPORT_MESSAGES = 200;

/**
 * §3 "Attachments" — the per-ticket attachment cap, matching `MAX_REQUEST_ATTACHMENTS` and
 * `MAX_MESSAGE_ATTACHMENTS`. A support attachment is a screenshot or a receipt.
 */
export const MAX_SUPPORT_ATTACHMENTS = 5;

/** The spec 027 context this spec registers. Added to `file_assets_context_type_ck` by 0029. */
export const SUPPORT_ATTACHMENT_CONTEXT: FileContextType = 'support_attachment';
