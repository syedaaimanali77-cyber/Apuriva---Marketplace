/**
 * Spec 036 AC-10, AC-11 — tool-call records join the EXISTING AI data lifecycle: exported in the
 * redacted structure only (spec 034's export), and hard-deleted by spec 008's account deletion sweep,
 * which still retains spec 034's `ai_actions` exactly as spec 034 decided.
 */
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { registerAndLogin } from '@/app/api/v1/users/me/privacy-test-support';
import { exportAiAssistantData } from '@/lib/ai-assistant/privacy';
import { getDb } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { queryRows } from '@/lib/offers/db';
import { sweepDeletions } from '@/lib/privacy/deletion';
import { REDACTED } from './fields';
import { isDatabaseReachable, seedConversation, seedPendingAction, toolCallRows } from './mcp-tools-test-support';
import { beginToolCall, completeToolCall } from './recorder';

const dbReachable = await isDatabaseReachable();

async function seedToolCalls(userId: string): Promise<{ aiActionId: string; key: string }> {
  const conversationId = await seedConversation(userId);
  const aiActionId = await seedPendingAction(conversationId, 'create_booking', 'high');
  const key = '0b9a2f0e-2f4b-4f63-9d7f-6a1e2b3c4d5e';
  const first = await beginToolCall({ aiActionId, idempotencyKey: key, inputParams: { offerId: aiActionId, note: REDACTED }, retriedFromCallId: null });
  await completeToolCall(first, { outputSummary: null, errorCode: 'INTERNAL_ERROR' });
  // A retry row referencing the first (RESTRICT) — deletion must still remove both.
  const retry = await beginToolCall({ aiActionId, idempotencyKey: key, inputParams: { offerId: aiActionId }, retriedFromCallId: first });
  await completeToolCall(retry, { outputSummary: { type: 'booking', id: aiActionId, status: 'pending' }, errorCode: null });
  return { aiActionId, key };
}

async function actionCount(aiActionId: string): Promise<number> {
  const [row] = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM ai_actions WHERE id = ${aiActionId}`);
  return row!.n;
}

describe.skipIf(!dbReachable)('spec 036 tool-call retention and privacy (integration)', () => {
  it('the AI data export includes each action’s tool calls in the redacted structure — never the key (AC-11)', async () => {
    const session = await registerAndLogin();
    const { aiActionId, key } = await seedToolCalls(session.userId);

    const exported = await exportAiAssistantData(session.userId);
    const entry = exported.activity.find((a) => a.id === aiActionId)!;
    expect(entry.toolCalls).toHaveLength(2);
    expect(entry.toolCalls[0]).toMatchObject({ inputParams: { offerId: aiActionId, note: REDACTED }, outputSummary: null, errorCode: 'INTERNAL_ERROR' });
    expect(entry.toolCalls[1]).toMatchObject({ outputSummary: { type: 'booking', id: aiActionId, status: 'pending' }, errorCode: null });
    expect(Object.keys(entry.toolCalls[0]!).sort()).toEqual(['createdAt', 'errorCode', 'inputParams', 'outputSummary']);
    expect(JSON.stringify(exported)).not.toContain(key);
  });

  it('account deletion hard-deletes the user’s tool calls; ai_actions stay as spec 034 decided (AC-10)', async () => {
    const deleted = await registerAndLogin();
    const kept = await registerAndLogin();
    const doomed = await seedToolCalls(deleted.userId);
    const survivor = await seedToolCalls(kept.userId);

    await getDb()
      .update(users)
      .set({ lifecycleStatus: 'deletion_pending', deletionGraceEndsAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, deleted.userId));
    await sweepDeletions();

    expect(await toolCallRows(doomed.aiActionId)).toEqual([]);
    expect(await actionCount(doomed.aiActionId)).toBe(1);
    // Nobody else's records are touched.
    expect(await toolCallRows(survivor.aiActionId)).toHaveLength(2);
  });
});
