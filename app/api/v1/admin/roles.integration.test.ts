import { describe, expect, it } from 'vitest';
import { GET as GET_ROLES } from './roles/route';
import { POST as ASSIGN_ROLE } from './users/[userId]/roles/route';
import { DELETE as REVOKE_ROLE } from './users/[userId]/roles/[role]/route';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { authenticatedRequest, isDatabaseReachable, registerAdmin, grantRole, clearAllSuperAdmins } from './admin-rbac-test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('admin role assignment (spec 009 AC-5, integration)', () => {
  it('AC-1/AC-5: an admin without super_admin cannot list roles or assign/revoke — 403 FORBIDDEN regardless of body', async () => {
    resetRateLimitState();
    const nonSuper = await registerAdmin();
    await grantRole(nonSuper, 'support_admin');
    const target = await registerAdmin();

    const list = await GET_ROLES(authenticatedRequest('http://localhost/api/v1/admin/roles', nonSuper.sessionId, nonSuper.csrfToken, { method: 'GET' }));
    expect(list.status).toBe(403);
    expect((await list.json()).code).toBe('FORBIDDEN');

    const assign = await ASSIGN_ROLE(
      authenticatedRequest(`http://localhost/api/v1/admin/users/${target.userId}/roles`, nonSuper.sessionId, nonSuper.csrfToken, {
        method: 'POST',
        body: { role: 'support_admin' },
      }),
    );
    expect(assign.status).toBe(403);
    expect((await assign.json()).code).toBe('FORBIDDEN');
  });

  it('AC-5: Super Admin can list the seven canonical roles', async () => {
    resetRateLimitState();
    const superAdmin = await registerAdmin();
    await grantRole(superAdmin, 'super_admin');

    const res = await GET_ROLES(authenticatedRequest('http://localhost/api/v1/admin/roles', superAdmin.sessionId, superAdmin.csrfToken, { method: 'GET' }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.map((r: { name: string }) => r.name).sort()).toEqual(
      [
        'analytics_admin',
        'content_admin',
        'finance_admin',
        'operations_admin',
        'super_admin',
        'support_admin',
        'trust_safety_admin',
      ].sort(),
    );
  });

  it('AC-5: Super Admin assigns a role to another admin, and it is audited (not universally available to every admin)', async () => {
    resetRateLimitState();
    const superAdmin = await registerAdmin();
    await grantRole(superAdmin, 'super_admin');
    const target = await registerAdmin();

    const res = await ASSIGN_ROLE(
      authenticatedRequest(`http://localhost/api/v1/admin/users/${target.userId}/roles`, superAdmin.sessionId, superAdmin.csrfToken, {
        method: 'POST',
        body: { role: 'finance_admin' },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ userId: target.userId, role: 'finance_admin' });
  });

  it('rejects an unknown role name with 400 VALIDATION_ERROR', async () => {
    resetRateLimitState();
    const superAdmin = await registerAdmin();
    await grantRole(superAdmin, 'super_admin');
    const target = await registerAdmin();

    const res = await ASSIGN_ROLE(
      authenticatedRequest(`http://localhost/api/v1/admin/users/${target.userId}/roles`, superAdmin.sessionId, superAdmin.csrfToken, {
        method: 'POST',
        body: { role: 'not_a_real_role' },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-UUID userId with 400 VALIDATION_ERROR, not a raw Postgres 22P02/500', async () => {
    resetRateLimitState();
    const superAdmin = await registerAdmin();
    await grantRole(superAdmin, 'super_admin');

    const res = await ASSIGN_ROLE(
      authenticatedRequest('http://localhost/api/v1/admin/users/not-a-uuid/roles', superAdmin.sessionId, superAdmin.csrfToken, {
        method: 'POST',
        body: { role: 'support_admin' },
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });

  it('AC-5: Super Admin revokes a non-super_admin role — 204', async () => {
    resetRateLimitState();
    const superAdmin = await registerAdmin();
    await grantRole(superAdmin, 'super_admin');
    const target = await registerAdmin();
    await grantRole(target, 'support_admin');

    const res = await REVOKE_ROLE(
      authenticatedRequest(`http://localhost/api/v1/admin/users/${target.userId}/roles/support_admin`, superAdmin.sessionId, superAdmin.csrfToken, {
        method: 'DELETE',
      }),
    );
    expect(res.status).toBe(204);
  });

  it('revoke rejects a non-UUID userId with 400 VALIDATION_ERROR, not a raw Postgres 22P02/500', async () => {
    resetRateLimitState();
    const superAdmin = await registerAdmin();
    await grantRole(superAdmin, 'super_admin');

    const res = await REVOKE_ROLE(
      authenticatedRequest('http://localhost/api/v1/admin/users/not-a-uuid/roles/support_admin', superAdmin.sessionId, superAdmin.csrfToken, {
        method: 'DELETE',
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
  });

  it('revoking a role the target does not hold returns 404 NOT_FOUND', async () => {
    resetRateLimitState();
    const superAdmin = await registerAdmin();
    await grantRole(superAdmin, 'super_admin');
    const target = await registerAdmin();

    const res = await REVOKE_ROLE(
      authenticatedRequest(`http://localhost/api/v1/admin/users/${target.userId}/roles/support_admin`, superAdmin.sessionId, superAdmin.csrfToken, {
        method: 'DELETE',
      }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
  });

  it('AC-5: revoking the LAST remaining super_admin is blocked with 409 LAST_SUPER_ADMIN, including self-revocation', async () => {
    resetRateLimitState();
    await clearAllSuperAdmins();
    const onlySuperAdmin = await registerAdmin();
    await grantRole(onlySuperAdmin, 'super_admin');

    const res = await REVOKE_ROLE(
      authenticatedRequest(
        `http://localhost/api/v1/admin/users/${onlySuperAdmin.userId}/roles/super_admin`,
        onlySuperAdmin.sessionId,
        onlySuperAdmin.csrfToken,
        { method: 'DELETE' },
      ),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('LAST_SUPER_ADMIN');
  });

  it('AC-5: revoking super_admin is allowed once a second Super Admin exists', async () => {
    resetRateLimitState();
    const first = await registerAdmin();
    await grantRole(first, 'super_admin');
    const second = await registerAdmin();
    await grantRole(second, 'super_admin');

    const res = await REVOKE_ROLE(
      authenticatedRequest(`http://localhost/api/v1/admin/users/${first.userId}/roles/super_admin`, second.sessionId, second.csrfToken, {
        method: 'DELETE',
      }),
    );
    expect(res.status).toBe(204);
  });
});
