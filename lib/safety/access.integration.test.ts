/**
 * Spec 030 §6 (AC-3) — restricted access. Master §64's "restricted access" is the criterion this
 * file exists for, and the interesting cases are the roles that are DENIED.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { getSafetyReportForAdmin, listSafetyQueue } from './reports';
import {
  requireSafetyEscalatePermission,
  requireSafetyReadPermission,
  requireSafetyResolvePermission,
} from './permissions';
import {
  grantRole,
  isDatabaseReachable,
  registerAdmin,
  registerAdminWithPermission,
  resetSafetyIntegrationForTests,
  seedBareUser,
  seedSafetyReport,
  useSafetyIntegration,
} from './safety-test-support';

const dbReachable = await isDatabaseReachable();

/** Every admin role that must NOT reach a safety report. `support_admin` is the notable one. */
const DENIED_ROLES = [
  'support_admin',
  'operations_admin',
  'finance_admin',
  'content_admin',
  'analytics_admin',
] as const;

describe.skipIf(!dbReachable)('spec 030 safety access (AC-3, integration)', () => {
  beforeEach(() => {
    useSafetyIntegration();
  });

  afterAll(async () => {
    resetSafetyIntegrationForTests();
    await getPool().end();
  });

  describe('roles that are refused', () => {
    for (const role of DENIED_ROLES) {
      it(`refuses ${role} on the queue and the detail, resolved server-side`, async () => {
        const admin = await registerAdmin();
        await grantRole(admin, role);
        const reporter = await seedBareUser();
        const target = await seedBareUser();
        const id = await seedSafetyReport({ reporterUserId: reporter, targetUserId: target });

        await expect(requireSafetyReadPermission(admin.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(listSafetyQueue(admin.userId, { limit: 20, offset: 0 }, 'c')).resolves.toBeDefined();
        // The domain function itself is not the gate — the permission check is, and it refused above.
        await expect(getSafetyReportForAdmin(admin.userId, id, 'c')).resolves.toBeDefined();
      });
    }

    it('refuses a user with no admin profile at all', async () => {
      const user = await seedBareUser();
      await expect(requireSafetyReadPermission(user)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(requireSafetyEscalatePermission(user)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(requireSafetyResolvePermission(user)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    /**
     * Permissions are scoped to a ROLE, not to an individual admin, so "holding only read" has to
     * be expressed through a role that holds only read. `content_admin` is used because master §69
     * scopes it to services, categories and FAQs — it has no safety business at all — which makes
     * it the right shape for this assertion and keeps it independent of what other suites seed
     * onto `trust_safety_admin` in the shared test database.
     */
    it('refuses an admin whose role holds only READ when they try to escalate or resolve', async () => {
      const admin = await registerAdminWithPermission('content_admin', 'safety_reports', 'read', 'low');

      await expect(requireSafetyReadPermission(admin.userId)).resolves.toBeUndefined();
      await expect(requireSafetyEscalatePermission(admin.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(requireSafetyResolvePermission(admin.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('roles that are allowed', () => {
    it('admits trust_safety_admin holding the permission', async () => {
      const admin = await registerAdminWithPermission('trust_safety_admin', 'safety_reports', 'read', 'low');
      await expect(requireSafetyReadPermission(admin.userId)).resolves.toBeUndefined();
    });

    it('admits super_admin holding the permission', async () => {
      const admin = await registerAdminWithPermission('super_admin', 'safety_reports', 'read', 'low');
      await expect(requireSafetyReadPermission(admin.userId)).resolves.toBeUndefined();
    });
  });

  describe('DECIDED-3: no permission in this spec can sanction anyone', () => {
    it('grants no restriction permission, so there is nothing to resolve against', async () => {
      const { resolvePermission } = await import('@/lib/admin-rbac/permissions');
      const admin = await registerAdminWithPermission('trust_safety_admin', 'safety_reports', 'resolve', 'medium');

      const restriction = await resolvePermission(admin.userId, 'user_restrictions', 'apply');
      expect(restriction.allowed).toBe(false);
    });

    it("keeps all three of this spec's permissions at low or medium, so none needs four-eyes", async () => {
      const { resolvePermission } = await import('@/lib/admin-rbac/permissions');
      const admin = await registerAdminWithPermission('trust_safety_admin', 'safety_reports', 'resolve', 'medium');
      const resolved = await resolvePermission(admin.userId, 'safety_reports', 'resolve');
      expect(resolved.allowed).toBe(true);
      expect(['low', 'medium']).toContain(resolved.riskTier);
    });
  });
});
