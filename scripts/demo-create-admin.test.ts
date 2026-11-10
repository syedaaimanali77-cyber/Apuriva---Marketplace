import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { completeLogin } from '@/lib/auth/login-flow';
import { verifyPassword } from '@/lib/auth/password';
import { isDatabaseReachable } from '@/lib/demo/demo-test-support';
import { databaseNameReader } from '@/lib/demo/guards';
import { createDemoAdmin, DEMO_ADMIN_ROLES } from '@/lib/demo/operator';

const dbReachable = await isDatabaseReachable();

/** Spec 045 §3.9 — the admin evaluator tool. Runs on the isolated `*_test` database with the name reader stubbed. */
describe('scripts/demo-create-admin — createDemoAdmin (spec 045 §3.9, D-2)', () => {
  const saved = { APP_ENV: process.env.APP_ENV, DEMO_MODE_ENABLED: process.env.DEMO_MODE_ENABLED };
  const noNonDemoUsers = async () => 0;

  beforeEach(() => {
    process.env.APP_ENV = 'staging';
    process.env.DEMO_MODE_ENABLED = 'true';
    vi.spyOn(databaseNameReader, 'read').mockReturnValue('apuriva_demo');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const email = () => `evaluator-${Math.random().toString(36).slice(2)}@example.test`;

  it('offers every canonical role except super_admin', () => {
    expect(DEMO_ADMIN_ROLES).not.toContain('super_admin');
    expect(DEMO_ADMIN_ROLES).toHaveLength(6);
  });

  it('refuses super_admin, an unknown role and a bad email before writing anything', async () => {
    await expect(createDemoAdmin({ email: email(), role: 'super_admin' }, noNonDemoUsers)).rejects.toMatchObject({ reason: 'super_admin_refused' });
    await expect(createDemoAdmin({ email: email(), role: 'root' }, noNonDemoUsers)).rejects.toMatchObject({ reason: 'invalid_role' });
    await expect(createDemoAdmin({ email: 'not-an-email', role: 'support_admin' }, noNonDemoUsers)).rejects.toMatchObject({ reason: 'invalid_email' });
  });

  it.each([
    ['APP_ENV=production', () => (process.env.APP_ENV = 'production'), 'production'],
    ['the flag off', () => (process.env.DEMO_MODE_ENABLED = 'false'), 'flag_off'],
    ['a database not ending in _demo', () => vi.spyOn(databaseNameReader, 'read').mockReturnValue('apuriva_test'), 'wrong_database'],
  ])('refuses with %s', async (_label, arrange, reason) => {
    arrange();
    await expect(createDemoAdmin({ email: email(), role: 'support_admin' }, noNonDemoUsers)).rejects.toMatchObject({ reason });
  });

  it('refuses while a non-demo user exists', async () => {
    await expect(createDemoAdmin({ email: email(), role: 'support_admin' }, async () => 3)).rejects.toMatchObject({
      reason: 'non_demo_users_present',
    });
  });

  it.skipIf(!dbReachable)('creates a demo admin with one role and no MFA secret; the normal login gives it a partial, MFA-pending session', async () => {
    const created = await createDemoAdmin({ email: email(), role: 'support_admin' }, noNonDemoUsers);
    const [row] = await queryRows<{ is_demo: boolean; password_hash: string; totp: string | null; enrolled: Date | null; roles: string[] }>(
      getDb(),
      sql`SELECT u.is_demo, u.password_hash, ap.totp_secret_encrypted AS totp, ap.mfa_enrolled_at AS enrolled,
                 ARRAY(SELECT r.name FROM admin_role_assignments ara JOIN roles r ON r.id = ara.role_id WHERE ara.admin_profile_id = ap.id) AS roles
            FROM users u JOIN admin_profiles ap ON ap.user_id = u.id WHERE u.id = ${created.userId}`,
    );
    expect(row!.is_demo).toBe(true);
    expect(row!.roles).toEqual(['support_admin']);
    expect(row!.totp).toBeNull();
    expect(row!.enrolled).toBeNull();
    expect(verifyPassword(created.oneTimePassword, row!.password_hash)).toBe(true);
    expect(row!.password_hash).not.toContain(created.oneTimePassword);

    // Spec 005 AC-5, unchanged: the evaluator's login is a partial session until MFA is completed.
    const { dto } = await completeLogin(created.userId, 'password');
    expect(dto.mfaRequired).toBe(true);
  });
});
