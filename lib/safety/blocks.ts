/**
 * Spec 030 §3 "Blocking" (AC-1) — the `user_blocks` record and every effect of a block.
 *
 * HOW A CLIENT NAMES THE PERSON TO BLOCK. Verified: `app/api/v1/users/` contains only `me/*`
 * routes, so there is no `users/{id}` convention to follow, and spec 020's booking DTOs
 * deliberately carry no counterparty `users.id`. Spec 025's `ConversationParticipantDto.userId`
 * and `MessageDto.senderUserId` DO expose it, so a block target is named by `targetUserId`, which
 * the client legitimately holds for anyone it has conversed with. Blocking a stranger is simply
 * not reachable from the UI and needs no extra rule: an unknown user is `404`.
 *
 * WHAT A BLOCK DOES NOT DO. It never cancels, alters or hides an existing booking, and it never
 * makes message history unreadable. This module writes no booking column and calls no transition.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import type { ConversationBlockStatus } from '@/lib/messaging/block-gate';
import { blockNotFoundError, cannotBlockSelfError, targetUserNotFoundError } from './errors';
import { toBlockDto, type BlockRow } from './rows';
import type { BlockDto } from '@/lib/types/safety';

/**
 * Creates a block, or replays the existing one.
 *
 * A duplicate returns the row that is already there rather than `409`: the caller owns that row, so
 * telling them it exists enumerates nothing, and an error would only teach people to retry.
 * `user_blocks_pair_uq` is what makes that true under concurrency — the loser of a race catches the
 * unique violation and re-reads, so two simultaneous blocks produce exactly one row.
 */
export async function createBlock(
  blockerUserId: string,
  targetUserId: string,
): Promise<{ block: BlockDto; replayed: boolean }> {
  if (blockerUserId === targetUserId) throw cannotBlockSelfError();

  const db = getDb();
  const [target] = await queryRows<{ id: string }>(db, sql`SELECT id FROM users WHERE id = ${targetUserId}`);
  if (!target) throw targetUserNotFoundError();

  const existing = await findBlock(db, blockerUserId, targetUserId);
  if (existing) return { block: toBlockDto(existing), replayed: true };

  try {
    const [row] = await queryRows<BlockRow>(
      db,
      sql`INSERT INTO user_blocks (blocker_user_id, blocked_user_id)
          VALUES (${blockerUserId}, ${targetUserId})
          RETURNING id, blocked_user_id, created_at`,
    );
    return { block: toBlockDto(row!), replayed: false };
  } catch (err) {
    if (isUniqueViolation(err, 'user_blocks_pair_uq')) {
      const raced = await findBlock(db, blockerUserId, targetUserId);
      if (raced) return { block: toBlockDto(raced), replayed: true };
    }
    throw err;
  }
}

async function findBlock(db: Executor, blockerUserId: string, blockedUserId: string): Promise<BlockRow | undefined> {
  const [row] = await queryRows<BlockRow>(
    db,
    sql`SELECT id, blocked_user_id, created_at FROM user_blocks
         WHERE blocker_user_id = ${blockerUserId} AND blocked_user_id = ${blockedUserId}`,
  );
  return row;
}

/** The caller's own blocks, newest first. Never anyone else's, and never "who blocked me". */
export async function listBlocks(
  blockerUserId: string,
  page: { limit: number; offset: number },
): Promise<{ rows: BlockDto[]; total: number }> {
  const db = getDb();
  const rows = await queryRows<BlockRow>(
    db,
    sql`SELECT id, blocked_user_id, created_at FROM user_blocks
         WHERE blocker_user_id = ${blockerUserId}
         ORDER BY created_at DESC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  const [count] = await queryRows<{ total: string }>(
    db,
    sql`SELECT count(*)::text AS total FROM user_blocks WHERE blocker_user_id = ${blockerUserId}`,
  );
  return { rows: rows.map(toBlockDto), total: Number(count?.total ?? 0) };
}

/**
 * Removes a block. Idempotent: deleting one that is not there is `204`, not `404`, because the
 * caller's intent ("I do not want this block") is already satisfied.
 *
 * A block id belonging to someone else is `404` — never `403`, which would confirm it exists.
 */
export async function removeBlock(blockerUserId: string, blockId: string): Promise<void> {
  const db = getDb();
  const [row] = await queryRows<{ id: string; blocker_user_id: string }>(
    db,
    sql`SELECT id, blocker_user_id FROM user_blocks WHERE id = ${blockId}`,
  );
  if (row && row.blocker_user_id !== blockerUserId) throw blockNotFoundError();
  if (!row) return;
  await db.execute(sql`DELETE FROM user_blocks WHERE id = ${blockId} AND blocker_user_id = ${blockerUserId}`);
}

/**
 * Spec 025's `ConversationBlockGate` implementation (AC-1).
 *
 * BIDIRECTIONAL IN EFFECT, one-directional as a record. Spec 025's port documents the requirement
 * exactly: "a block in EITHER direction must report `blocked`". Whether A blocked B or B blocked A,
 * neither may send to the other — a one-way rule would let the blocker keep talking at someone who
 * asked them to stop.
 *
 * It runs inside the CALLER's transaction, so a block committed a moment earlier is already
 * visible to the send that follows it.
 */
export async function conversationBlockStatus(
  tx: Executor,
  senderUserId: string,
  counterpartyUserId: string,
): Promise<ConversationBlockStatus> {
  const rows = await queryRows<{ blocker_user_id: string }>(
    tx,
    sql`SELECT blocker_user_id FROM user_blocks
         WHERE (blocker_user_id = ${senderUserId} AND blocked_user_id = ${counterpartyUserId})
            OR (blocker_user_id = ${counterpartyUserId} AND blocked_user_id = ${senderUserId})`,
  );
  if (rows.length === 0) return { blocked: false };
  // If the sender is the blocker they blocked the counterparty; otherwise they were blocked.
  const senderIsBlocker = rows.some((r) => r.blocker_user_id === senderUserId);
  return { blocked: true, reason: senderIsBlocker ? 'blocked_counterparty' : 'blocked_by_counterparty' };
}

/**
 * Spec 017's `ProviderBlockSource` implementation (AC-1).
 *
 * One batched query resolves the user-scoped block set onto provider-profile-scoped candidates, so
 * matching never issues a query per candidate. Bidirectional for the same reason as messaging: a
 * provider who blocked this customer should not be offered their work either.
 */
export async function blockedProviderProfileIds(
  customerUserId: string,
  providerProfileIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (providerProfileIds.length === 0) return new Set<string>();
  const rows = await queryRows<{ id: string }>(
    getDb(),
    sql`SELECT pp.id
          FROM provider_profiles pp
          JOIN user_blocks ub
            ON (ub.blocker_user_id = ${customerUserId} AND ub.blocked_user_id = pp.user_id)
            OR (ub.blocked_user_id = ${customerUserId} AND ub.blocker_user_id = pp.user_id)
         WHERE pp.id IN (${sql.join(
           providerProfileIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})`,
  );
  return new Set(rows.map((r) => r.id));
}
