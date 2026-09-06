import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { customerProfiles, providerProfiles, sessions } from '@/lib/db/schema';
import type { ActiveMode } from '@/lib/types/users';

export interface ProfileFlags {
  hasCustomerProfile: boolean;
  hasProviderProfile: boolean;
}

/** Spec 006 §3/§4: which profiles exist for a user, as surfaced by `GET /api/v1/users/me`. */
export async function getProfileFlags(userId: string): Promise<ProfileFlags> {
  const db = getDb();
  const [[customer], [provider]] = await Promise.all([
    db.select({ id: customerProfiles.id }).from(customerProfiles).where(eq(customerProfiles.userId, userId)),
    db.select({ id: providerProfiles.id }).from(providerProfiles).where(eq(providerProfiles.userId, userId)),
  ]);
  return { hasCustomerProfile: Boolean(customer), hasProviderProfile: Boolean(provider) };
}

/**
 * Spec 006 §1/§4: every user is a customer by default — provisioned once at account creation,
 * never via a self-service "Become a Customer" action. Called from spec 005's `completeLogin`
 * (the single choke point every login-completing endpoint funnels through), not from each
 * register/login/oauth route individually. Idempotent: a repeat call for the same user is a
 * no-op (`user_id` is unique on this table).
 */
export async function ensureCustomerProfile(userId: string): Promise<void> {
  await getDb().insert(customerProfiles).values({ userId }).onConflictDoNothing({ target: customerProfiles.userId });
}

export interface CreateProviderProfileResult {
  profile: typeof providerProfiles.$inferSelect;
  created: boolean;
}

/**
 * Spec 006 AC-1, `POST /api/v1/users/me/provider-profile` — idempotent: creates a
 * `ProviderProfile` linked to the user if one doesn't already exist, otherwise returns the
 * existing one. Never touches the session's active mode — switching mode is a separate,
 * explicit action (AC-2).
 */
export async function ensureProviderProfile(userId: string): Promise<CreateProviderProfileResult> {
  const db = getDb();
  const [existing] = await db.select().from(providerProfiles).where(eq(providerProfiles.userId, userId));
  if (existing) return { profile: existing, created: false };

  const [inserted] = await db
    .insert(providerProfiles)
    .values({ userId })
    .onConflictDoNothing({ target: providerProfiles.userId })
    .returning();
  if (inserted) return { profile: inserted, created: true };

  // Lost a race against a concurrent create for the same user — the row exists now; fetch it.
  const [row] = await db.select().from(providerProfiles).where(eq(providerProfiles.userId, userId));
  return { profile: row!, created: false };
}

/**
 * Spec 006 §4/AC-2/AC-5 — sets `active_mode` on the CURRENT SESSION (never `User`). The caller
 * is responsible for having already verified the corresponding profile exists (§4 "a mode
 * cannot be selected unless the corresponding profile exists"); this function only performs the
 * server-authoritative write.
 */
export async function setSessionActiveMode(sessionId: string, mode: ActiveMode): Promise<void> {
  await getDb().update(sessions).set({ activeMode: mode }).where(eq(sessions.id, sessionId));
}
