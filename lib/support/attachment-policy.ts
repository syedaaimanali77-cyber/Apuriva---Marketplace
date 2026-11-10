/**
 * Spec 032 §3 "Attachments" (DECIDED-8) — the spec 027 context policy, and nothing more.
 *
 * SPEC 027 IS REUSED WHOLESALE. There is no second storage system here, no new media route and no
 * re-implemented scanning: `upload-url → finalize`, the scan gate, signed URLs, deletion and the
 * retention sweep are all spec 027's, unchanged. This file supplies the one thing spec 027 asks a
 * consuming spec for — who may attach to this context, and who may read back.
 *
 * `support_attachment` was added to `file_assets_context_type_ck` by migration 0029, exactly as
 * spec 029's 0026 added `review_media`: the vocabulary is closed at the database, so a consuming
 * spec adds its own value rather than reusing another's.
 *
 * UNTIL `registerSupportAttachmentContext()` RUNS, the context is unregistered and spec 027 answers
 * `422 FILE_CONTEXT_NOT_AVAILABLE`. That is the documented default and is what rolling this spec
 * back returns to, so no shipped spec breaks.
 *
 * INTERNAL-NOTE ATTACHMENTS ARE DELIBERATELY NOT SUPPORTED. One context, one policy, one
 * authorization rule. An admin with something to share attaches it to their reply, where the user
 * can actually see it — which is the only place an admin-supplied file is useful.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import { registerFileContextPolicy, type FileContextPolicy } from '@/lib/files/contexts/registry';
import type { SupportTicketStatus } from '@/lib/types/support';
import { MAX_SUPPORT_ATTACHMENTS, SUPPORT_ATTACHMENT_CONTEXT } from './limits';
import { hasSupportReadPermission } from './permissions';
import { isLiveSupportStatus } from './transitions';

async function loadTicket(
  ticketId: string | null,
): Promise<{ requesterUserId: string; status: SupportTicketStatus } | null> {
  if (!ticketId || !isUuid(ticketId)) return null;
  const [row] = await queryRows<{ requester_user_id: string; status: SupportTicketStatus }>(
    getDb(),
    sql`SELECT requester_user_id, status FROM support_tickets WHERE id = ${ticketId}`,
  );
  return row ? { requesterUserId: row.requester_user_id, status: row.status } : null;
}

export const supportAttachmentPolicy: FileContextPolicy = {
  /**
   * NEVER public. A support attachment is a screenshot of someone's problem — often their own
   * account, their own booking, their own money. `portfolio` remains the only public-eligible
   * context in this repository.
   */
  publicEligible: false,
  maxPerContext: MAX_SUPPORT_ATTACHMENTS,
  /** A screenshot or a receipt, which is what a support attachment is. */
  allowedKinds: ['image', 'document'],

  /** The requester, while the ticket is still live. `contextId` is the TICKET id. */
  async canUpload({ userId, contextId }) {
    const ticket = await loadTicket(contextId);
    if (!ticket) return false;
    if (!isLiveSupportStatus(ticket.status)) return false;
    return ticket.requesterUserId === userId;
  },

  /**
   * The requester, or an admin holding `support/read`.
   *
   * The non-throwing permission form is used because spec 027's interface wants a boolean — the
   * same shape spec 031's `hasDisputeReadPermission` serves for `dispute_evidence`.
   */
  async canRead({ userId, asset }) {
    const ticket = await loadTicket(asset.context_id);
    if (!ticket) return false;
    if (ticket.requesterUserId === userId) return true;
    return hasSupportReadPermission(userId);
  },
};

export function registerSupportAttachmentContext(): void {
  registerFileContextPolicy(SUPPORT_ATTACHMENT_CONTEXT, supportAttachmentPolicy);
}
