/**
 * Spec 025 §3 "Admin and support access" (AC-5).
 *
 * The authorization boundary is spec 009's `resolvePermission` on `(messaging, read_conversation)`, which
 * migration 0021 seeds for `support_admin`, `trust_safety_admin` and `super_admin` ONLY — so every other
 * admin role is excluded by the narrowness of the seed, not by a filter here. Every read supplies a
 * mandatory reason and writes an audit event BEFORE any data is returned: if the audit write fails, the
 * request fails and nothing is disclosed. Paging is audited per page. There is no admin write path, and an
 * active block never restricts this access (master spec §53).
 */
import { sql } from 'drizzle-orm';
import { forbiddenError, validationError } from '@/lib/api/errors';
import { parsePageParams } from '@/lib/api/pagination';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { getAdminRoleNames, resolvePermission } from '@/lib/admin-rbac/permissions';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import type { BookingStatus } from '@/lib/types/bookings';
import type { AdminConversationDto, ConversationParticipantRole } from '@/lib/types/messaging';
import { conversationNotFoundError } from './errors';
import { isArchivedBookingStatus } from './lifecycle';
import { ADMIN_REASON_MAX_LENGTH, ADMIN_REASON_MIN_LENGTH } from './limits';
import { listConversationMessages, type PagedMessages } from './messages';

export const MESSAGING_RESOURCE = 'messaging';
export const READ_CONVERSATION_ACTION = 'read_conversation';

export async function requireConversationReadPermission(adminUserId: string): Promise<void> {
  const permission = await resolvePermission(adminUserId, MESSAGING_RESOURCE, READ_CONVERSATION_ACTION);
  if (!permission.allowed) throw forbiddenError('You are not authorized to read conversations.');
}

/** Trimmed 10–500 characters. Absent, blank or too short is `400` before any data is loaded. */
export function validateAdminReason(raw: string | null): string {
  const reason = (raw ?? '').trim();
  if (reason.length < ADMIN_REASON_MIN_LENGTH || reason.length > ADMIN_REASON_MAX_LENGTH) {
    throw validationError([
      { field: 'reason', message: `is required and must be ${ADMIN_REASON_MIN_LENGTH}-${ADMIN_REASON_MAX_LENGTH} characters` },
    ]);
  }
  return reason;
}

interface AdminContext {
  adminUserId: string;
  conversationId: string;
  reason: string;
  correlationId: string;
}

async function loadConversationBooking(conversationId: string): Promise<{ bookingId: string; bookingStatus: BookingStatus }> {
  if (!isUuid(conversationId)) throw conversationNotFoundError();
  const [row] = await queryRows<{ booking_id: string; status: BookingStatus }>(
    getDb(),
    sql`SELECT c.booking_id, b.status FROM conversations c JOIN bookings b ON b.id = c.booking_id WHERE c.id = ${conversationId}`,
  );
  if (!row) throw conversationNotFoundError();
  return { bookingId: row.booking_id, bookingStatus: row.status };
}

async function audit(context: AdminContext, eventType: string, extra?: Record<string, unknown>): Promise<void> {
  await recordAdminAuditEvent({
    actorUserId: context.adminUserId,
    actorRoles: await getAdminRoleNames(context.adminUserId),
    eventType,
    resource: MESSAGING_RESOURCE,
    action: READ_CONVERSATION_ACTION,
    targetType: 'conversation',
    targetId: context.conversationId,
    reason: context.reason,
    approvalChain: extra ?? [],
    correlationId: context.correlationId,
  });
}

/** `GET /api/v1/admin/conversations/{id}` — metadata and participants only, never bodies. */
export async function readConversationForAdmin(context: AdminContext): Promise<AdminConversationDto> {
  const { bookingId, bookingStatus } = await loadConversationBooking(context.conversationId);

  const [row] = await queryRows<{
    archived_at: Date | null;
    retention_applied_at: Date | null;
    message_count: number;
    contact_flagged_count: number;
    first_message_at: Date | null;
    last_message_at: Date | null;
  }>(
    getDb(),
    sql`SELECT c.archived_at, c.retention_applied_at,
               count(m.id)::int AS message_count,
               count(m.id) FILTER (WHERE m.contact_flagged OR m.contact_redacted)::int AS contact_flagged_count,
               min(m.created_at) AS first_message_at, max(m.created_at) AS last_message_at
          FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id
         WHERE c.id = ${context.conversationId}
         GROUP BY c.id`,
  );
  const participants = await queryRows<{ user_id: string; role: ConversationParticipantRole }>(
    getDb(),
    sql`SELECT user_id, role FROM conversation_participants WHERE conversation_id = ${context.conversationId} ORDER BY role ASC`,
  );

  const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);
  const dto: AdminConversationDto = {
    id: context.conversationId,
    bookingId,
    participants: participants.map((p) => ({ userId: p.user_id, role: p.role })),
    isActive: !isArchivedBookingStatus(bookingStatus),
    archivedAt: iso(row!.archived_at),
    retentionAppliedAt: iso(row!.retention_applied_at),
    messageCount: Number(row!.message_count),
    contactFlaggedCount: Number(row!.contact_flagged_count),
    firstMessageAt: iso(row!.first_message_at),
    lastMessageAt: iso(row!.last_message_at),
  };

  await audit(context, 'messaging.admin_conversation_read');
  return dto;
}

/** `GET /api/v1/admin/conversations/{id}/messages` — carries bodies, so audited per page. */
export async function listConversationMessagesForAdmin(context: AdminContext, searchParams: URLSearchParams): Promise<PagedMessages> {
  await loadConversationBooking(context.conversationId);
  // Admin reads are offset-paged only; the `after` delta read is a participant polling mechanism.
  const params = new URLSearchParams(searchParams);
  params.delete('after');
  const result = await listConversationMessages(getDb(), context.conversationId, params);

  const page = parsePageParams(params);
  await audit(context, 'messaging.admin_messages_read', { limit: page.limit, offset: page.offset });
  return result;
}
