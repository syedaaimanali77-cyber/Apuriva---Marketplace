import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { auditLogs } from '@/lib/db/schema';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { recordAdminAuditEvent } from '@/lib/admin-rbac/audit';
import { POST as CREATE_CATEGORY } from '@/app/api/v1/admin/categories/route';
import { authenticatedRequest, registerContentAdmin } from '@/app/api/v1/catalog/catalog-test-support';
import { registerAndLogin } from '@/app/api/v1/users/me/privacy-test-support';
import { runWithRequestContext } from '@/lib/audit/request-context';
import { auditRowsByEventType, isDatabaseReachable, uniqueTag } from './audit-test-support';

const dbReachable = await isDatabaseReachable();

function slug(): string {
  return `spec039-${Math.random().toString(36).slice(2, 10)}`;
}

async function createCategory(admin: { sessionId: string; csrfToken: string }, correlationId?: string): Promise<{ id: string; correlationId: string }> {
  const base = authenticatedRequest('http://localhost/api/v1/admin/categories', admin.sessionId, admin.csrfToken, {
    method: 'POST',
    body: { name: 'Correlated', slug: slug() },
  });
  const headers = new Headers(base.headers);
  if (correlationId) headers.set('x-correlation-id', correlationId);
  const res = await CREATE_CATEGORY(new Request(base, { headers }));
  expect(res.status).toBe(201);
  const json = (await res.json()) as { data: { id: string }; correlationId: string };
  return { id: json.data.id, correlationId: json.correlationId };
}

async function categoryAuditCorrelation(categoryId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ correlationId: auditLogs.correlationId })
    .from(auditLogs)
    .where(and(eq(auditLogs.eventType, 'catalog.category_created'), eq(auditLogs.targetId, categoryId)));
  expect(row).toBeDefined();
  return row!.correlationId;
}

/**
 * Spec 039 AC-6 — x-correlation-id → withApiRoute → request context → recordAdminAuditEvent →
 * audit_logs.correlation_id. Spec 010's catalog writer passes NO correlation id of its own, so this
 * proves the X-1 context is what links the entry to the request.
 */
describe.skipIf(!dbReachable)('audit correlation (spec 039 AC-6)', { timeout: 60_000 }, () => {
  beforeEach(() => resetRateLimitState());

  it('the caller-supplied x-correlation-id is stored verbatim on the audit entry', async () => {
    const admin = await registerContentAdmin();
    const supplied = uniqueTag('caller-corr');
    const { id, correlationId } = await createCategory(admin, supplied);
    expect(correlationId).toBe(supplied);
    expect(await categoryAuditCorrelation(id)).toBe(supplied);
  });

  it('without one, the generated id returned in the response envelope is the one stored', async () => {
    const admin = await registerContentAdmin();
    const { id, correlationId } = await createCategory(admin);
    expect(correlationId).toBeTruthy();
    expect(await categoryAuditCorrelation(id)).toBe(correlationId);
  });

  it('an explicit correlationId passed by the caller wins over the request context', async () => {
    const user = await registerAndLogin();
    const eventType = uniqueTag('spec039.explicit');
    await runWithRequestContext({ correlationId: 'context-id' }, () =>
      recordAdminAuditEvent({ actorUserId: user.userId, actorRoles: [], eventType, resource: 'support', action: 'x', approvalChain: [], correlationId: 'explicit-id' }),
    );
    const [row] = await auditRowsByEventType(eventType);
    expect(row!.correlationId).toBe('explicit-id');
  });

  it('an action with no originating API request (cron/system) records null', async () => {
    const user = await registerAndLogin();
    const eventType = uniqueTag('spec039.noreq');
    await recordAdminAuditEvent({ actorUserId: user.userId, actorRoles: [], eventType, resource: 'support', action: 'x', approvalChain: [] });
    const [row] = await auditRowsByEventType(eventType);
    expect(row!.correlationId).toBeNull();
  });
});
