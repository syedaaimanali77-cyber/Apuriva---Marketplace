/**
 * Spec 037 §6 — the Admin Dashboard journey, end to end through the real route handlers against the
 * isolated `*_test` database (the repository's Vitest e2e convention; there is no Playwright).
 *
 * An operations_admin: loads the Overview; finds a support ticket in the unified queue and follows
 * its link to spec 032's existing detail route; opens Marketplace configuration and follows its link
 * to spec 017's matching editor; changes a weight THERE (the only writer); and finds the audit event
 * with before/after that the change produced (AC-5) — while the dashboard itself wrote nothing.
 */
import { AUDIT_EVENTS } from '@/lib/audit/audit-test-support';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { DEFAULT_MATCHING_WEIGHTS } from '@/lib/matching/weights';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { GET as GET_OVERVIEW } from '@/app/api/v1/admin/overview/route';
import { GET as GET_QUEUE } from '@/app/api/v1/admin/operations/queue/route';
import { GET as GET_CONFIG } from '@/app/api/v1/admin/marketplace/config/route';
import { GET as GET_SUPPORT_TICKET } from '@/app/api/v1/admin/support/tickets/[id]/route';
import { PATCH as PATCH_WEIGHTS } from '@/app/api/v1/admin/services/[id]/matching-weights/route';
import { adminWithRole, insertSupportTicket, isDatabaseReachable } from '@/lib/admin-dashboard/admin-dashboard-test-support';
import type { OperationsQueueItemDto } from '@/lib/types/admin-dashboard';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1';

describe.skipIf(!dbReachable)('e2e: spec 037 admin dashboard journey', () => {
  afterAll(async () => {
    await getPool().end();
  });

  it('operations admin: overview → queue → existing detail → configuration → owning editor → audited change', async () => {
    resetRateLimitState();
    const admin = await adminWithRole('operations_admin');
    const get = (url: string) => authenticatedRequest(url, admin.sessionId, admin.csrfToken, { method: 'GET' });

    // A committed open ticket — something that genuinely needs attention.
    const client = await getPool().connect();
    let ticketId: string;
    try {
      ticketId = await insertSupportTicket(client, { priority: 'critical', status: 'open' });
    } finally {
      client.release();
    }

    // 1. The Overview.
    const overview = await GET_OVERVIEW(get(`${BASE}/admin/overview`));
    expect(overview.status).toBe(200);
    const figures = (await overview.json()).data;
    expect(figures.activeRequests).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(figures.revenueToday)).toBe(true);

    // 2. The unified queue contains the ticket (critical sorts first; page until found regardless).
    let item: OperationsQueueItemDto | undefined;
    for (let offset = 0; !item; offset += 100) {
      const res = await GET_QUEUE(get(`${BASE}/admin/operations/queue?limit=100&offset=${offset}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      item = (body.data as OperationsQueueItemDto[]).find((i) => i.id === ticketId);
      if (body.page.nextOffset === null) break;
    }
    expect(item).toMatchObject({ type: 'support_ticket', priority: 'critical', linkTo: `/admin/operations/support/${ticketId}` });

    // 3. Following the link lands on spec 032's existing workflow, which this admin may read.
    const detail = await GET_SUPPORT_TICKET(get(`${BASE}/admin/support/tickets/${ticketId}`));
    expect(detail.status).toBe(200);

    // 4. Marketplace configuration links to spec 017's editor; the dashboard offers no write.
    const config = (await (await GET_CONFIG(get(`${BASE}/admin/marketplace/config`))).json()).data;
    expect(config.matching.linkTo).toBe('/admin/marketplace/matching');
    expect(config.matching.platformDefaultWeights).toEqual(DEFAULT_MATCHING_WEIGHTS);

    // 5. The change is made in the owning editor's path (spec 017), and is audited with before/after.
    const suffix = randomUUID().slice(0, 8);
    const [category] = await queryRows<{ id: string }>(
      getDb(),
      sql`INSERT INTO categories (name, slug) VALUES (${`E2E ${suffix}`}, ${`e2e-${suffix}`}) RETURNING id`,
    );
    const [service] = await queryRows<{ id: string }>(
      getDb(),
      sql`INSERT INTO services (category_id, name, slug) VALUES (${category!.id}, ${`E2E Service ${suffix}`}, ${`e2e-service-${suffix}`}) RETURNING id`,
    );
    const weights = { ...DEFAULT_MATCHING_WEIGHTS, rating: 20, reliability: 0 };
    const patched = await PATCH_WEIGHTS(
      authenticatedRequest(`${BASE}/admin/services/${service!.id}/matching-weights`, admin.sessionId, admin.csrfToken, {
        method: 'PATCH',
        body: { weights },
      }),
    );
    expect(patched.status).toBe(200);

    const [event] = await queryRows<{ metadata: Record<string, unknown> }>(
      getDb(),
      sql`SELECT metadata FROM ${AUDIT_EVENTS}
           WHERE user_id = ${admin.userId} AND event_type = 'admin_rbac.matching_weights_updated'`,
    );
    expect(event!.metadata).toMatchObject({
      targetId: service!.id,
      before: { weights: null, poolSize: null },
      after: { weights, poolSize: null },
    });

    // 6. The configuration overview now reflects the change it did not make.
    const after = (await (await GET_CONFIG(get(`${BASE}/admin/marketplace/config`))).json()).data;
    expect(after.matching.serviceOverrideCount).toBeGreaterThanOrEqual(1);
  });
});
