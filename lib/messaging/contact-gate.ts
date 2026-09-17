/**
 * Spec 025 §3 "Contact-sharing protection" (AC-2). PURE — no I/O, no logging.
 *
 * Detection is spec 019's `redactContactInfo()`, reused unchanged: one pattern set for the whole
 * platform. What this spec adds is only the booking-stage decision of what to DO with a match:
 *
 *   - pre-`confirmed` → MASK: only the matched token becomes `[contact removed]`; the unredacted text is
 *     returned to nobody and must never be persisted or logged by the caller.
 *   - `confirmed`+   → FLAG: the body is kept verbatim and `contactFlagged` is set as the T&S signal.
 *
 * Neither branch ever rejects a message.
 */
import { redactContactInfo } from '@/lib/negotiation/contact-redaction';

export interface ContactPolicyResult {
  /** The form to store and deliver. */
  body: string;
  contactRedacted: boolean;
  contactFlagged: boolean;
  /** How many contact patterns were detected. */
  matchCount: number;
}

export function applyContactPolicy(input: string, contactSharingAllowed: boolean): ContactPolicyResult {
  const detection = redactContactInfo(input);
  if (detection.count === 0) {
    return { body: input, contactRedacted: false, contactFlagged: false, matchCount: 0 };
  }
  if (contactSharingAllowed) {
    return { body: input, contactRedacted: false, contactFlagged: true, matchCount: detection.count };
  }
  return { body: detection.text, contactRedacted: true, contactFlagged: false, matchCount: detection.count };
}
