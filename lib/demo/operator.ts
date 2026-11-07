/**
 * Spec 045 §3.5 / §3.9 — the two operator-only tools behind `scripts/demo-reseed.ts` and
 * `scripts/demo-create-admin.ts`. Never HTTP routes. Both refuse unless the §3.1 conditions 1–3 hold (not
 * production, `demo-mode` on, a `_demo` database) and unless the database holds no non-demo user, so neither
 * can ever run against a real staging or production database.
 *
 * The side effects that leave the database (drop/recreate, migrate) are injected, so their guards are tested
 * without ever touching a real database.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { ADMIN_ROLES } from '@/lib/db/schema';
import { hashPassword } from '@/lib/auth/password';
import { queryRows, type Executor } from '@/lib/offers/db';
import type { AdminRole } from '@/lib/types/admin-rbac';
import { databaseNameReader, demoAvailability, type DemoUnavailableReason } from './guards';

export class DemoOperatorRefusal extends Error {
  constructor(
    readonly reason: DemoUnavailableReason | 'non_demo_users_present' | 'super_admin_refused' | 'invalid_role' | 'invalid_email' | 'email_taken',
    message: string,
  ) {
    super(message);
    this.name = 'DemoOperatorRefusal';
  }
}

/** §3.5 — the database must contain demo users only. A real account found here is never deleted by a tool. */
export async function countNonDemoUsers(db: Executor = getDb()): Promise<number> {
  const [row] = await queryRows<{ n: number }>(db, sql`SELECT count(*)::int AS n FROM users WHERE is_demo = false`);
  return row!.n;
}

/** §3.1 conditions 1–3, then the non-demo-user guard. Throws `DemoOperatorRefusal`; returns the database name. */
export async function assertOperatorMayRun(readNonDemoCount: () => Promise<number> = countNonDemoUsers): Promise<string> {
  const availability = await demoAvailability();
  if (!availability.available) {
    throw new DemoOperatorRefusal(availability.reason, `Refusing: not a demo environment (${availability.reason}).`);
  }
  const nonDemo = await readNonDemoCount();
  if (nonDemo > 0) {
    throw new DemoOperatorRefusal(
      'non_demo_users_present',
      `Refusing: ${nonDemo} non-demo user(s) exist in this database. Remove them deliberately first; this tool never deletes them.`,
    );
  }
  return databaseNameReader.read();
}

export interface ReseedSteps {
  /** Drops and recreates ONLY the named `_demo` database. */
  dropAndRecreate: (databaseName: string) => Promise<void>;
  /** Applies every migration (`npm run db:migrate`'s migrator), which re-seeds the catalog (0006) and the flags. */
  migrate: () => Promise<void>;
  readNonDemoCount?: () => Promise<number>;
}

/** §3.5 — the guarded environment reseed. */
export async function reseedDemoEnvironment(steps: ReseedSteps): Promise<{ databaseName: string }> {
  const databaseName = await assertOperatorMayRun(steps.readNonDemoCount);
  await steps.dropAndRecreate(databaseName);
  await steps.migrate();
  console.log(JSON.stringify({ event: 'demo.environment_reseeded', databaseName }));
  return { databaseName };
}

/** The roles an evaluator may be given: every canonical spec 009 role except `super_admin` (§3.9). */
export const DEMO_ADMIN_ROLES = ADMIN_ROLES.filter((role) => role !== 'super_admin') as Exclude<AdminRole, 'super_admin'>[];

export interface CreatedDemoAdmin {
  userId: string;
  role: AdminRole;
  /** Shown once to the operator; only its scrypt hash is stored. */
  oneTimePassword: string;
}

/**
 * §3.9 — an operator-provisioned admin evaluator: a demo `users` row (with a password the operator hands over,
 * so the evaluator can use spec 005's normal email login), an `admin_profiles` row and ONE spec 009 role
 * assignment. No MFA secret is generated, shared or skipped: spec 005's `completeLogin` gives this admin a
 * partial session, and the evaluator enrols and uses MFA exactly as every admin does.
 */
export async function createDemoAdmin(input: { email: string; role: string }, readNonDemoCount?: () => Promise<number>): Promise<CreatedDemoAdmin> {
  await assertOperatorMayRun(readNonDemoCount);

  if (input.role === 'super_admin') {
    throw new DemoOperatorRefusal('super_admin_refused', 'Refusing: super_admin cannot be given to a demo evaluator (it controls developer flags, including demo-mode).');
  }
  if (!(DEMO_ADMIN_ROLES as readonly string[]).includes(input.role)) {
    throw new DemoOperatorRefusal('invalid_role', `Refusing: role must be one of ${DEMO_ADMIN_ROLES.join(', ')}.`);
  }
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new DemoOperatorRefusal('invalid_email', 'Refusing: --email must be an email address.');
  }

  const oneTimePassword = randomBytes(18).toString('base64url');
  const role = input.role as AdminRole;

  const userId = await getDb().transaction(async (tx) => {
    const [taken] = await queryRows<{ id: string }>(tx, sql`SELECT id FROM users WHERE lower(email) = lower(${email})`);
    if (taken) throw new DemoOperatorRefusal('email_taken', 'Refusing: an account with that email already exists.');

    const [user] = await queryRows<{ id: string }>(
      tx,
      sql`INSERT INTO users (email, password_hash, is_demo) VALUES (${email}, ${hashPassword(oneTimePassword)}, true) RETURNING id`,
    );
    const [profile] = await queryRows<{ id: string }>(tx, sql`INSERT INTO admin_profiles (user_id) VALUES (${user!.id}) RETURNING id`);
    const [roleRow] = await queryRows<{ id: string }>(tx, sql`SELECT id FROM roles WHERE name = ${role}`);
    if (!roleRow) throw new DemoOperatorRefusal('invalid_role', `Refusing: role ${role} is not seeded.`);
    await tx.execute(sql`INSERT INTO admin_role_assignments (admin_profile_id, role_id) VALUES (${profile!.id}, ${roleRow.id})`);
    return user!.id;
  });

  console.log(JSON.stringify({ event: 'demo.admin_provisioned', userId, role }));
  return { userId, role, oneTimePassword };
}
