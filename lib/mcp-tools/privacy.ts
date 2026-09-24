/**
 * Spec 036 §4 "Retention and privacy" (AC-10) — this spec's section of spec 008's EXISTING account
 * deletion flow (`lib/privacy/deletion.ts`), the per-spec contribution pattern specs 015–019,
 * 024–027 and 034 use there. No parallel mechanism and no retention period.
 *
 * A deleted account's tool-call records do NOT survive: they are hard-deleted. Spec 034's
 * `ai_actions` rows they belong to are retained exactly as spec 034 decided, and nothing here
 * touches them. Retry rows are deleted before the rows they reference, because
 * `retried_from_call_id` is `RESTRICT`.
 */
import { sql } from 'drizzle-orm';
import type { Executor } from '@/lib/offers/db';

export async function removeAiToolCallsForDeletedUser(db: Executor, userId: string): Promise<void> {
  const ownActions = sql`SELECT a.id FROM ai_actions a
                           JOIN ai_conversations c ON c.id = a.ai_conversation_id
                          WHERE c.user_id = ${userId}`;
  await db.execute(sql`DELETE FROM ai_tool_calls WHERE retried_from_call_id IS NOT NULL AND ai_action_id IN (${ownActions})`);
  await db.execute(sql`DELETE FROM ai_tool_calls WHERE ai_action_id IN (${ownActions})`);
}
