/**
 * Spec 032 §3 "Messages" — admin-internal notes.
 *
 * A NOTE IS NEVER A ROW IN `support_messages`. That separation is the whole privacy design: no
 * projection bug in the thread query can leak an internal note to a requester, because the thread
 * query does not read this table and no participant code path anywhere in `lib/support/` does
 * either. `lib/support/privacy.test.ts` asserts that at source level as well as over serialized
 * JSON.
 *
 * Every function here is reached only from `app/api/v1/admin/support/**`, behind
 * `support/respond` (write) or `support/read` (read).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import type { PageParams } from '@/lib/api/pagination';
import type { SupportNoteDto } from '@/lib/types/support';
import { supportTicketClosedError } from './errors';
import { loadTicketRow } from './lifecycle';
import { auditSupport, SUPPORT_EVENT_TYPES } from './audit';
import { toSupportNoteDto, type SupportNoteRow } from './rows';
import { isLiveSupportStatus } from './transitions';

const NOTE_COLUMNS = 'id, author_user_id, body, created_at';

export async function addInternalNote(input: {
  adminUserId: string;
  ticketId: string;
  body: string;
  idempotency: { key: string; fingerprint: string };
  correlationId: string | null;
}): Promise<{ note: SupportNoteDto; replayed: boolean }> {
  const db = getDb();

  const existing = await queryRows<SupportNoteRow>(
    db,
    sql`SELECT ${sql.raw(NOTE_COLUMNS)} FROM support_notes
         WHERE author_user_id = ${input.adminUserId} AND idempotency_key = ${input.idempotency.key}`,
  );
  if (existing[0]) return { note: toSupportNoteDto(existing[0]), replayed: true };

  const ticket = await loadTicketRow(input.ticketId, db);
  // Notes follow the ticket: once it is resolved or closed the record is settled and stays settled.
  if (!isLiveSupportStatus(ticket.status)) throw supportTicketClosedError();

  const [row] = await queryRows<SupportNoteRow>(
    db,
    sql`INSERT INTO support_notes
          (support_ticket_id, author_user_id, body, idempotency_key, idempotency_fingerprint)
        VALUES (${input.ticketId}, ${input.adminUserId}, ${input.body},
                ${input.idempotency.key}, ${input.idempotency.fingerprint})
        RETURNING ${sql.raw(NOTE_COLUMNS)}`,
  );

  await auditSupport({
    adminUserId: input.adminUserId,
    eventType: SUPPORT_EVENT_TYPES.noteAdded,
    targetId: input.ticketId,
    correlationId: input.correlationId,
    details: { noteId: row!.id },
  });

  return { note: toSupportNoteDto(row!), replayed: false };
}

/** Oldest first, matching the thread, so the two read side by side in the admin workspace. */
export async function listNotes(
  ticketId: string,
  page: PageParams,
): Promise<{ items: SupportNoteDto[]; total: number }> {
  const db = getDb();

  const [countRow] = await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM support_notes WHERE support_ticket_id = ${ticketId}`,
  );

  const rows = await queryRows<SupportNoteRow>(
    db,
    sql`SELECT ${sql.raw(NOTE_COLUMNS)} FROM support_notes
         WHERE support_ticket_id = ${ticketId}
         ORDER BY created_at ASC, id ASC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );

  return { items: rows.map(toSupportNoteDto), total: countRow?.total ?? 0 };
}
