import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import type { Executor } from '@/lib/offers/db';
import type { OperationsQueueItemDto } from '@/lib/types/admin-dashboard';
import type { AdminRole } from '@/lib/types/admin-rbac';
import {
  adminWithRole,
  roleHoldsPermission,
  insertDispute,
  insertSafetyReport,
  insertSupportTicket,
  isDatabaseReachable,
  seedRealBooking,
  withSnapshot,
} from './admin-dashboard-test-support';
import { compareQueueItems, queueSourcesFor, readOperationsQueue, type QueueSources } from './queue';

const dbReachable = await isDatabaseReachable();

const ALL: QueueSources = { disputes: true, supportTickets: true, safetyReports: true };

const ROLES: AdminRole[] = [
  'super_admin',
  'operations_admin',
  'support_admin',
  'trust_safety_admin',
  'finance_admin',
  'content_admin',
  'analytics_admin',
];

/** Every page of the queue inside one snapshot — assertions are over the whole listing. */
async function readAll(db: Executor, sources: QueueSources): Promise<{ items: OperationsQueueItemDto[]; total: number }> {
  const items: OperationsQueueItemDto[] = [];
  let total = 0;
  for (let offset = 0; ; offset += 100) {
    const page = await readOperationsQueue(db, sources, { limit: 100, offset });
    total = page.total;
    items.push(...page.items);
    if (page.items.length < 100) break;
  }
  return { items, total };
}

describe.skipIf(!dbReachable)('spec 037 Operations queue (AC-2, integration)', () => {
  let booking: { bookingId: string; customerUserId: string };

  beforeAll(async () => {
    booking = await seedRealBooking();
  }, 120_000);

  afterAll(async () => {
    await getPool().end();
  });

  it('each source only for its read permission, per role', async () => {
    // What the migrations grant — asserted positively, since no test ever removes a seeded grant.
    const seeded: Partial<Record<AdminRole, Partial<QueueSources>>> = {
      super_admin: { disputes: true, supportTickets: true, safetyReports: true },
      operations_admin: { disputes: true, supportTickets: true },
      support_admin: { supportTickets: true },
      trust_safety_admin: { disputes: true, safetyReports: true },
    };
    for (const role of ROLES) {
      const admin = await adminWithRole(role);
      const sources = await queueSourcesFor(admin.userId);
      // Exactly the sources whose read permission this role holds right now — never more.
      expect(sources, role).toEqual({
        disputes: await roleHoldsPermission(role, 'disputes', 'read'),
        supportTickets: await roleHoldsPermission(role, 'support', 'read'),
        safetyReports: await roleHoldsPermission(role, 'safety_reports', 'read'),
      });
      expect(sources, role).toMatchObject(seeded[role] ?? {});
    }
  }, 60_000);

  it('terminal items are excluded; open ones appear with their type, status, priority and existing link', async () => {
    await withSnapshot(async (db, client) => {
      const openDispute = await insertDispute(client, { ...booking, openedByUserId: booking.customerUserId, status: 'open' });
      const closedDispute = await insertDispute(client, { ...booking, openedByUserId: booking.customerUserId, status: 'closed' });
      const openTicket = await insertSupportTicket(client, { priority: 'high', status: 'open' });
      const resolvedTicket = await insertSupportTicket(client, { priority: 'critical', status: 'resolved' });
      const closedTicket = await insertSupportTicket(client, { priority: 'critical', status: 'closed' });
      const openReport = await insertSafetyReport(client, { priority: 'critical', status: 'under_review' });
      const resolvedReport = await insertSafetyReport(client, { priority: 'critical', status: 'resolved' });

      const { items } = await readAll(db, ALL);
      const byId = new Map(items.map((i) => [i.id, i]));

      expect(byId.get(openDispute)).toMatchObject({ type: 'dispute', status: 'open', priority: null, linkTo: `/admin/operations/disputes/${openDispute}` });
      expect(byId.get(openTicket)).toMatchObject({ type: 'support_ticket', status: 'open', priority: 'high', linkTo: `/admin/operations/support/${openTicket}` });
      expect(byId.get(openReport)).toMatchObject({ type: 'safety_report', status: 'under_review', priority: 'critical', linkTo: '/admin/operations/safety' });
      for (const terminal of [closedDispute, resolvedTicket, closedTicket, resolvedReport]) expect(byId.has(terminal)).toBe(false);

      // Identifiers, status and priority only — no free-text summary (D-10).
      for (const i of items) expect(Object.keys(i).sort()).toEqual(['createdAt', 'id', 'linkTo', 'priority', 'status', 'type']);
    });
  });

  it('orders the whole listing by priority then age, and total counts only permitted sources', async () => {
    await withSnapshot(async (db, client) => {
      await insertSafetyReport(client, { priority: 'low', status: 'submitted' });
      await insertSupportTicket(client, { priority: 'critical', status: 'open' });
      await insertDispute(client, { ...booking, openedByUserId: booking.customerUserId, status: 'open' });

      const all = await readAll(db, ALL);
      expect(all.items).toEqual([...all.items].sort(compareQueueItems));
      expect(all.total).toBe(all.items.length);

      const supportOnly = await readAll(db, { disputes: false, supportTickets: true, safetyReports: false });
      expect(supportOnly.items.length).toBeGreaterThan(0);
      expect(new Set(supportOnly.items.map((i) => i.type))).toEqual(new Set(['support_ticket']));
      expect(supportOnly.total).toBe(supportOnly.items.length);

      const disputesAndSafety = await readAll(db, { disputes: true, supportTickets: false, safetyReports: true });
      expect(disputesAndSafety.items.every((i) => i.type !== 'support_ticket')).toBe(true);
    });
  });

  it('pages with limit/offset over the same order', async () => {
    await withSnapshot(async (db, client) => {
      for (let n = 0; n < 3; n += 1) await insertSupportTicket(client, { priority: 'medium', status: 'open' });
      const sources = { disputes: false, supportTickets: true, safetyReports: false };
      const full = await readAll(db, sources);
      const first = await readOperationsQueue(db, sources, { limit: 2, offset: 0 });
      const second = await readOperationsQueue(db, sources, { limit: 2, offset: 2 });
      expect([...first.items, ...second.items]).toEqual(full.items.slice(0, 4));
      expect(first.total).toBe(full.total);
    });
  });
});
