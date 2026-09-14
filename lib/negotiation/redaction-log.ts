/**
 * Spec 019 §3 "Contact redaction" item 6 — the one structured signal a redaction emits (consumed by spec
 * 038). It carries identifiers and a count only: the redacted or unredacted CONTENT is never logged.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';

export type RedactedField = 'body' | 'note' | 'providerMessage' | 'includedItems';

export async function logContactRedaction(senderUserId: string, requestId: string, field: RedactedField): Promise<void> {
  const [row] = await queryRows<{ n: number }>(
    getDb(),
    sql`SELECT count(*)::int AS n FROM offer_messages
         WHERE sender_user_id = ${senderUserId} AND contact_redacted
           AND created_at > clock_timestamp() - interval '24 hours'`,
  );
  console.log(
    JSON.stringify({ event: 'negotiation.contact_redacted', senderUserId, requestId, field, redactedCount24h: row?.n ?? 0 }),
  );
}
