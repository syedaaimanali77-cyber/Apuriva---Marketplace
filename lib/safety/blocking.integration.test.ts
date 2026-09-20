/**
 * Spec 030 §6 (AC-1) — what a block actually does, and the three things it deliberately does not.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { checkConversationBlock, getConversationBlockGate } from '@/lib/messaging/block-gate';
import { loadBlockedProviderProfileIds, resetProviderBlockSource } from '@/lib/matching/block-source';
import { createBlock, listBlocks, removeBlock } from './blocks';
import { isDatabaseReachable, resetSafetyIntegrationForTests, seedBareUser, useSafetyIntegration } from './safety-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('spec 030 blocking (AC-1, integration)', () => {
  beforeEach(() => {
    useSafetyIntegration();
  });

  afterAll(async () => {
    resetSafetyIntegrationForTests();
    await getPool().end();
  });

  describe('the record', () => {
    it('creates a block and lists it for its owner only', async () => {
      const a = await seedBareUser();
      const b = await seedBareUser();

      const { block, replayed } = await createBlock(a, b);
      expect(replayed).toBe(false);
      expect(block.blockedUserId).toBe(b);

      const mine = await listBlocks(a, { limit: 20, offset: 0 });
      expect(mine.rows.map((r) => r.blockedUserId)).toContain(b);

      // The blocked user is never told: their own list is empty.
      const theirs = await listBlocks(b, { limit: 20, offset: 0 });
      expect(theirs.rows).toHaveLength(0);
    });

    it('replays a duplicate rather than erroring, so a retry is never punished', async () => {
      const a = await seedBareUser();
      const b = await seedBareUser();

      const first = await createBlock(a, b);
      const second = await createBlock(a, b);

      expect(second.replayed).toBe(true);
      expect(second.block.id).toBe(first.block.id);

      const [count] = await queryRows<{ total: string }>(
        getDb(),
        sql`SELECT count(*)::text AS total FROM user_blocks WHERE blocker_user_id = ${a} AND blocked_user_id = ${b}`,
      );
      expect(Number(count!.total)).toBe(1);
    });

    it('rejects blocking yourself', async () => {
      const a = await seedBareUser();
      await expect(createBlock(a, a)).rejects.toMatchObject({ code: 'CANNOT_BLOCK_SELF' });
    });

    it('is enforced at the database too — a direct self-block violates the CHECK', async () => {
      const a = await seedBareUser();
      await expect(
        getDb().execute(sql`INSERT INTO user_blocks (blocker_user_id, blocked_user_id) VALUES (${a}, ${a})`),
      ).rejects.toThrow();
    });

    it('rejects an unknown target with 404', async () => {
      const a = await seedBareUser();
      await expect(createBlock(a, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('effect on messaging — spec 025 port', () => {
    it('is registered by registerSafetyIntegration, replacing the inert default', async () => {
      const a = await seedBareUser();
      const b = await seedBareUser();
      await createBlock(a, b);

      const status = await getConversationBlockGate()(getDb(), a, b);
      expect(status.blocked).toBe(true);
    });

    it('blocks in BOTH directions — the blocked party cannot send back either', async () => {
      const a = await seedBareUser();
      const b = await seedBareUser();
      await createBlock(a, b);

      const blockerSending = await checkConversationBlock(getDb(), a, b, 'conversation-1');
      const blockedSending = await checkConversationBlock(getDb(), b, a, 'conversation-1');

      expect(blockerSending.blocked).toBe(true);
      expect(blockerSending.reason).toBe('blocked_counterparty');
      expect(blockedSending.blocked).toBe(true);
      expect(blockedSending.reason).toBe('blocked_by_counterparty');
    });

    it('reports not-blocked for an unrelated pair', async () => {
      const a = await seedBareUser();
      const b = await seedBareUser();
      const c = await seedBareUser();
      await createBlock(a, b);

      expect((await checkConversationBlock(getDb(), a, c, 'x')).blocked).toBe(false);
    });

    it('unblocking restores sending immediately — the gate reads live, with no cache', async () => {
      const a = await seedBareUser();
      const b = await seedBareUser();
      const { block } = await createBlock(a, b);

      expect((await checkConversationBlock(getDb(), a, b, 'x')).blocked).toBe(true);
      await removeBlock(a, block.id);
      expect((await checkConversationBlock(getDb(), a, b, 'x')).blocked).toBe(false);
    });

    it('is idempotent to unblock something that is not there', async () => {
      const a = await seedBareUser();
      await expect(removeBlock(a, '00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined();
    });

    it("refuses to let one user delete another's block, and says 404 rather than 403", async () => {
      const a = await seedBareUser();
      const b = await seedBareUser();
      const c = await seedBareUser();
      const { block } = await createBlock(a, b);

      await expect(removeBlock(c, block.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('effect on matching — spec 017 port', () => {
    it('defaults to nobody-blocked when unregistered, i.e. spec 017 pre-030 behaviour', async () => {
      resetProviderBlockSource();
      const a = await seedBareUser();
      const result = await loadBlockedProviderProfileIds(a, ['11111111-1111-1111-1111-111111111111']);
      expect(result.size).toBe(0);
    });

    it('returns an empty set for an empty candidate pool without touching the database', async () => {
      const a = await seedBareUser();
      expect((await loadBlockedProviderProfileIds(a, [])).size).toBe(0);
    });
  });

  describe('what a block deliberately does NOT do', () => {
    it('writes no account state — the blocked user stays active', async () => {
      const a = await seedBareUser();
      const b = await seedBareUser();
      await createBlock(a, b);

      const [row] = await queryRows<{ lifecycle_status: string }>(
        getDb(),
        sql`SELECT lifecycle_status FROM users WHERE id = ${b}`,
      );
      expect(row!.lifecycle_status).toBe('active');
    });
  });
});
