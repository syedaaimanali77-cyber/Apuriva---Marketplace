/**
 * Spec 038 §3.4 — lifecycle transitions.
 *
 * THE ONLY MODULE IN THE REPOSITORY THAT WRITES `restricted`, `suspended` OR `banned` to
 * `users.lifecycle_status` or `provider_profiles.lifecycle_status`. It is called only from
 * `lib/moderation/actions.ts`, inside that module's transaction, after the target lock is held;
 * `lib/moderation/boundary.test.ts` asserts both facts at source level. No API route and no other
 * spec writes a sanction value.
 *
 * Scope `provider_profile` writes the profile only (spec 008's schema comment: a suspended profile
 * does not mean a suspended account). Scope `account` writes the user row — unless the account is
 * `deletion_pending`, whose column belongs to spec 008's deletion flow; there the standing is carried
 * by the active action and read by `getAccountStanding()` — and CASCADES to the provider profile,
 * because matching (specs 016/017) reads only the profile.
 */
import { sql } from 'drizzle-orm';
import { queryRows, type Executor } from '@/lib/offers/db';
import { LIFECYCLE_STANDING_FOR } from './catalogue';
import { lifecycleStateChangedError, targetNotModeratableError } from './errors';
import { getAccountStanding, standingToLifecycle, STANDING_SEVERITY, type Standing } from './standing';
import type { ModerationActionType, ModerationScope } from '@/lib/types/moderation';

/** What the lifecycle module needs to know about an action. */
export interface LifecycleSubject {
  action_type: ModerationActionType;
  scope: ModerationScope;
  target_user_id: string;
  provider_profile_id: string | null;
  previous_user_standing?: Standing | null;
  previous_provider_lifecycle_status?: string | null;
}

export interface LifecycleOutcome {
  previousUserStanding: Standing | null;
  previousProviderLifecycleStatus: string | null;
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}

const USER_SANCTIONABLE = ['active', 'restricted', 'suspended', 'banned'];

function severityOfStatus(status: string): number {
  return status in STANDING_SEVERITY ? STANDING_SEVERITY[status as Standing] : 0;
}

const NO_CHANGE: LifecycleOutcome = { previousUserStanding: null, previousProviderLifecycleStatus: null, before: {}, after: {} };

/** Applies an action's standing. Caller holds the target lock and the transaction. */
export async function applyLifecycleAction(tx: Executor, subject: LifecycleSubject): Promise<LifecycleOutcome> {
  const standing = LIFECYCLE_STANDING_FOR[subject.action_type];
  if (!standing) return NO_CHANGE;

  if (subject.scope === 'provider_profile') {
    const [profile] = await queryRows<{ lifecycle_status: string }>(
      tx,
      sql`SELECT lifecycle_status FROM provider_profiles WHERE id = ${subject.provider_profile_id} FOR UPDATE`,
    );
    if (!profile || profile.lifecycle_status === 'banned') throw targetNotModeratableError('provider_banned');
    await tx.execute(sql`
      UPDATE provider_profiles SET lifecycle_status = ${standing}, updated_at = clock_timestamp(), version = version + 1
       WHERE id = ${subject.provider_profile_id}`);
    return {
      previousUserStanding: null,
      previousProviderLifecycleStatus: profile.lifecycle_status,
      before: { providerLifecycleStatus: profile.lifecycle_status },
      after: { providerLifecycleStatus: standing },
    };
  }

  const [user] = await queryRows<{ lifecycle_status: string }>(
    tx,
    sql`SELECT lifecycle_status FROM users WHERE id = ${subject.target_user_id} FOR UPDATE`,
  );
  if (!user || user.lifecycle_status === 'deleted') throw targetNotModeratableError('account_deleted');

  // Read BEFORE this action is active, so it is the standing this action displaces.
  const previousUserStanding = await getAccountStanding(tx, subject.target_user_id);
  const before: Record<string, string | null> = { userLifecycleStatus: user.lifecycle_status };
  const after: Record<string, string | null> = { userLifecycleStatus: user.lifecycle_status };

  if (USER_SANCTIONABLE.includes(user.lifecycle_status)) {
    await tx.execute(sql`
      UPDATE users SET lifecycle_status = ${standing}, updated_at = clock_timestamp(), version = version + 1
       WHERE id = ${subject.target_user_id}`);
    after.userLifecycleStatus = standing;
  }

  // Cascade — only ever UP in severity, so an account restriction never softens a profile ban.
  let previousProviderLifecycleStatus: string | null = null;
  const [profile] = await queryRows<{ id: string; lifecycle_status: string }>(
    tx,
    sql`SELECT id, lifecycle_status FROM provider_profiles WHERE user_id = ${subject.target_user_id} FOR UPDATE`,
  );
  if (profile && STANDING_SEVERITY[standing] > severityOfStatus(profile.lifecycle_status)) {
    await tx.execute(sql`
      UPDATE provider_profiles SET lifecycle_status = ${standing}, updated_at = clock_timestamp(), version = version + 1
       WHERE id = ${profile.id}`);
    previousProviderLifecycleStatus = profile.lifecycle_status;
    before.providerLifecycleStatus = profile.lifecycle_status;
    after.providerLifecycleStatus = standing;
  }

  return { previousUserStanding, previousProviderLifecycleStatus, before, after };
}

/**
 * Reverses an ACTIVE action's standing. Every write is conditional on the column still holding the
 * value this action set; any mismatch is `409 LIFECYCLE_STATE_CHANGED` and — because the caller's
 * transaction rolls back — nothing at all is written.
 */
export async function reverseLifecycleAction(tx: Executor, subject: LifecycleSubject): Promise<LifecycleOutcome> {
  const standing = LIFECYCLE_STANDING_FOR[subject.action_type];
  if (!standing) return NO_CHANGE;

  if (subject.scope === 'provider_profile') {
    const previous = subject.previous_provider_lifecycle_status ?? 'active';
    const updated = await queryRows<{ id: string }>(
      tx,
      sql`UPDATE provider_profiles SET lifecycle_status = ${previous}, updated_at = clock_timestamp(), version = version + 1
           WHERE id = ${subject.provider_profile_id} AND lifecycle_status = ${standing}
           RETURNING id`,
    );
    if (updated.length === 0) throw lifecycleStateChangedError();
    return {
      previousUserStanding: null,
      previousProviderLifecycleStatus: null,
      before: { providerLifecycleStatus: standing },
      after: { providerLifecycleStatus: previous },
    };
  }

  const [user] = await queryRows<{ lifecycle_status: string }>(
    tx,
    sql`SELECT lifecycle_status FROM users WHERE id = ${subject.target_user_id} FOR UPDATE`,
  );
  if (!user || user.lifecycle_status === 'deleted') throw targetNotModeratableError('account_deleted');

  const before: Record<string, string | null> = { userLifecycleStatus: user.lifecycle_status };
  const after: Record<string, string | null> = { userLifecycleStatus: user.lifecycle_status };

  // A `deletion_pending` column belongs to spec 008; the standing lives on the action row only.
  if (user.lifecycle_status !== 'deletion_pending') {
    const restored = standingToLifecycle(subject.previous_user_standing ?? 'good');
    const updated = await queryRows<{ id: string }>(
      tx,
      sql`UPDATE users SET lifecycle_status = ${restored}, updated_at = clock_timestamp(), version = version + 1
           WHERE id = ${subject.target_user_id} AND lifecycle_status = ${standing}
           RETURNING id`,
    );
    if (updated.length === 0) throw lifecycleStateChangedError();
    after.userLifecycleStatus = restored;
  }

  if (subject.previous_provider_lifecycle_status) {
    const updated = await queryRows<{ id: string }>(
      tx,
      sql`UPDATE provider_profiles SET lifecycle_status = ${subject.previous_provider_lifecycle_status},
                 updated_at = clock_timestamp(), version = version + 1
           WHERE user_id = ${subject.target_user_id} AND lifecycle_status = ${standing}
           RETURNING id`,
    );
    if (updated.length === 0) throw lifecycleStateChangedError();
    before.providerLifecycleStatus = standing;
    after.providerLifecycleStatus = subject.previous_provider_lifecycle_status;
  }

  return { previousUserStanding: null, previousProviderLifecycleStatus: null, before, after };
}
