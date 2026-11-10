/** Spec 045 — reads of the demo markers on `users` (§4). Never an authorization shortcut: every caller re-reads. */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import type { DemoPersona } from '@/lib/types/demo';

/** X-7 — `users.is_demo` for `GET /users/me`. A missing user is not a demo user. */
export async function isDemoUser(userId: string, db: Executor = getDb()): Promise<boolean> {
  const [row] = await queryRows<{ is_demo: boolean }>(db, sql`SELECT is_demo FROM users WHERE id = ${userId}`);
  return row?.is_demo === true;
}

export interface DemoUserContext {
  isDemo: boolean;
  demoSetId: string | null;
  /** The persona a reset provisions again (§3.2 D2 step 4). */
  persona: DemoPersona;
}

/**
 * The caller's demo context for D2. A demo visitor only ever signs in as their set's persona user, and
 * only the provider persona owns a provider profile, so the profile decides the persona to provision again.
 * If a customer persona became a provider during their visit, the reset follows what they now are.
 */
export async function readDemoUserContext(userId: string, db: Executor = getDb()): Promise<DemoUserContext | null> {
  const [row] = await queryRows<{ is_demo: boolean; demo_set_id: string | null; has_provider: boolean }>(
    db,
    sql`SELECT u.is_demo, u.demo_set_id,
               EXISTS (SELECT 1 FROM provider_profiles pp WHERE pp.user_id = u.id) AS has_provider
          FROM users u WHERE u.id = ${userId}`,
  );
  if (!row) return null;
  return { isDemo: row.is_demo, demoSetId: row.demo_set_id, persona: row.has_provider ? 'provider' : 'customer' };
}
