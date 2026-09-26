/**
 * Spec 038 §3.5 — account and provider STANDING: the one read every enforcement point uses.
 *
 * THIS IS A LEAF MODULE. It imports only `@/lib/db` and this spec's errors, so spec 005's
 * `requireSession` and the spec 015/018/019/020 services can import it (as
 * `@/lib/moderation/standing`, never the barrel) without pulling in payouts, safety or auth — and
 * without an import cycle. `lib/moderation/boundary.test.ts` asserts the import list.
 *
 * It WRITES NOTHING. Sanction values are written only by `lib/moderation/lifecycle.ts`; everything
 * here is a fresh read with no caching, so a reversal takes effect on the very next request.
 */
import { sql } from 'drizzle-orm';
import type { getDb } from '@/lib/db';
import {
  accountBannedError,
  accountRestrictedError,
  accountSuspendedError,
  providerNotInGoodStandingError,
} from './errors';

type Executor = Pick<ReturnType<typeof getDb>, 'execute'>;

export type Standing = 'good' | 'restricted' | 'suspended' | 'banned';

const SANCTION_STATUSES: readonly string[] = ['restricted', 'suspended', 'banned'];

export const STANDING_SEVERITY: Record<Standing, number> = { good: 0, restricted: 1, suspended: 2, banned: 3 };

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

/**
 * - `users.lifecycle_status` in `restricted|suspended|banned` → that value;
 * - `deletion_pending` → the most severe ACTIVE account-scope sanction (so requesting deletion never
 *   lifts a sanction during the grace period), else `good`;
 * - `active` / `deleted` / unknown user → `good`.
 */
export async function getAccountStanding(executor: Executor, userId: string): Promise<Standing> {
  const [row] = rowsOf<{ lifecycle_status: string; active_standing: Standing | null }>(
    await executor.execute(sql`
      SELECT u.lifecycle_status,
             (SELECT CASE m.action_type WHEN 'ban' THEN 'banned' WHEN 'suspension' THEN 'suspended' ELSE 'restricted' END
                FROM moderation_actions m
               WHERE m.target_user_id = u.id
                 AND m.scope = 'account'
                 AND m.status = 'active'
                 AND m.action_type IN ('restriction', 'suspension', 'ban')
               ORDER BY CASE m.action_type WHEN 'ban' THEN 3 WHEN 'suspension' THEN 2 ELSE 1 END DESC
               LIMIT 1) AS active_standing
        FROM users u
       WHERE u.id = ${userId}`),
  );
  if (!row) return 'good';
  if (SANCTION_STATUSES.includes(row.lifecycle_status)) return row.lifecycle_status as Standing;
  if (row.lifecycle_status === 'deletion_pending') return row.active_standing ?? 'good';
  return 'good';
}

/** `provider_profiles.lifecycle_status` in `restricted|suspended|banned` → that value, else `good`. */
export async function getProviderStanding(executor: Executor, providerProfileId: string): Promise<Standing> {
  const [row] = rowsOf<{ lifecycle_status: string }>(
    await executor.execute(sql`SELECT lifecycle_status FROM provider_profiles WHERE id = ${providerProfileId}`),
  );
  if (row && SANCTION_STATUSES.includes(row.lifecycle_status)) return row.lifecycle_status as Standing;
  return 'good';
}

/** The lifecycle value a standing corresponds to (`good` → `active`). Used by spec 008's X-6. */
export function standingToLifecycle(standing: Standing): 'active' | 'restricted' | 'suspended' | 'banned' {
  return standing === 'good' ? 'active' : standing;
}

/** Suspended and banned accounts reach only the §3.5 allow-list (X-1). */
export function isSessionBlockingStanding(standing: Standing): boolean {
  return standing === 'suspended' || standing === 'banned';
}

/** The `403` a session gate or marketplace entry point raises for a non-`good` standing. */
export function standingError(standing: Exclude<Standing, 'good'>) {
  if (standing === 'banned') return accountBannedError();
  if (standing === 'suspended') return accountSuspendedError();
  return accountRestrictedError();
}

/** X-3…X-5: the acting account must be in good standing to start new marketplace activity. */
export async function assertAccountMayTransact(executor: Executor, userId: string): Promise<void> {
  const standing = await getAccountStanding(executor, userId);
  if (standing !== 'good') throw standingError(standing);
}

/** X-4/X-5: the offering or booked provider profile must be in good standing. */
export async function assertProviderMayTransact(executor: Executor, providerProfileId: string): Promise<void> {
  const standing = await getProviderStanding(executor, providerProfileId);
  if (standing !== 'good') throw providerNotInGoodStandingError(standing);
}
