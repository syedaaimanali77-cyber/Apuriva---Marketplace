/**
 * Spec 037 test support.
 *
 * The dashboard's figures are PLATFORM-WIDE, and Vitest runs test files in parallel against one
 * shared `*_test` database, so an absolute count would be at the mercy of whatever another file
 * inserted a millisecond earlier. Every aggregate assertion therefore runs inside `withSnapshot`: one
 * REPEATABLE READ transaction, rolled back at the end. Rows other files commit meanwhile are invisible
 * to it, so a before/after DELTA over rows this test inserts (or moves) is exact — and nothing it
 * writes survives the test.
 */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { getPool } from '@/lib/db';
import type { Executor } from '@/lib/offers/db';
import { createBooking } from '@/lib/bookings/create';
import { createBookingBody, seedBookingScenario } from '@/lib/bookings/bookings-test-support';
import { grantRole, registerAdmin, type TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import type { AdminRole } from '@/lib/types/admin-rbac';

export { isDatabaseReachable } from '@/lib/db/test-support';

/** Runs `fn` in a REPEATABLE READ snapshot that is ALWAYS rolled back. */
export async function withSnapshot(fn: (db: Executor, client: PoolClient) => Promise<void>): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await fn(drizzle(client) as unknown as Executor, client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/**
 * A fresh admin holding exactly `role`. Permissions come from the REAL seeds the owning specs'
 * migrations installed — nothing is seeded here, so every RBAC assertion tests the actual matrix.
 */
export async function adminWithRole(role: AdminRole): Promise<TestAdmin> {
  // Role sweeps register several accounts back to back; the in-process `auth` limiter would refuse
  // them, and it is not what these tests are about (the pattern other suites use).
  resetRateLimitState();
  const admin = await registerAdmin();
  await grantRole(admin, role);
  return admin;
}

/**
 * Whether `role` holds `(resource, action)` in the LIVE `permissions` table. The migrations' seeds
 * are the baseline, but other specs' tests legitimately add grants to the shared test database
 * (e.g. spec 030's access test grants `content_admin` `safety_reports/read`), so a role sweep that
 * asserts a refusal derives it from here instead of assuming the pristine seed matrix.
 */
export async function roleHoldsPermission(role: AdminRole, resource: string, action: string): Promise<boolean> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM permissions p JOIN roles r ON r.id = p.role_id
      WHERE r.name = $1 AND p.resource = $2 AND p.action = $3`,
    [role, resource, action],
  );
  return rows[0]!.n > 0;
}

/** A bare `users` row, for FK columns that need a user and nothing else. */
export async function insertUser(client: PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>('INSERT INTO users DEFAULT VALUES RETURNING id');
  return rows[0]!.id;
}

/** One real booking, created through specs 018/020's own path (it starts `confirmed`). */
export async function seedRealBooking(): Promise<{ bookingId: string; customerUserId: string }> {
  const scenario = await seedBookingScenario();
  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
  return { bookingId: booking.id, customerUserId: scenario.customer.userId };
}

export async function insertSafetyReport(
  client: PoolClient,
  input: { priority: 'low' | 'medium' | 'high' | 'critical'; status: 'submitted' | 'under_review' | 'escalated' | 'resolved' },
): Promise<string> {
  const reporter = await insertUser(client);
  const target = await insertUser(client);
  // `safety_reports_resolution_pairing_ck`: a resolved report names its resolving admin, reason and time.
  let resolverAdminId: string | null = null;
  if (input.status === 'resolved') {
    const { rows: admin } = await client.query<{ id: string }>(
      'INSERT INTO admin_profiles (user_id) VALUES ($1) RETURNING id',
      [await insertUser(client)],
    );
    resolverAdminId = admin[0]!.id;
  }
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO safety_reports
       (reporter_user_id, target_user_id, category, description, priority, status,
        resolved_at, resolved_by_admin_id, resolution_reason, idempotency_key, idempotency_fingerprint)
     VALUES ($1, $2, 'harassment', 'Spec 037 dashboard fixture report.', $3, $4,
             CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END, $5::uuid,
             CASE WHEN $5::uuid IS NULL THEN NULL ELSE 'Fixture resolution.' END, $6, 'fp')
     RETURNING id`,
    [reporter, target, input.priority, input.status, resolverAdminId, randomUUID()],
  );
  return rows[0]!.id;
}

export async function insertSupportTicket(
  client: PoolClient,
  input: { priority: 'low' | 'medium' | 'high' | 'critical'; status: 'open' | 'assigned' | 'awaiting_user' | 'resolved' | 'closed' },
): Promise<string> {
  const requester = await insertUser(client);
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO support_tickets
       (requester_user_id, subject, description, category, priority, status, requester_mode, sla_deadline_at,
        closed_at, idempotency_key, idempotency_fingerprint)
     VALUES ($1, 'Fixture', 'Spec 037 dashboard fixture ticket.', 'other', $2, $3, 'customer', now() + interval '1 day',
             CASE WHEN $3 = 'closed' THEN now() ELSE NULL END, $4, 'fp')
     RETURNING id`,
    [requester, input.priority, input.status, randomUUID()],
  );
  return rows[0]!.id;
}

export async function insertDispute(
  client: PoolClient,
  input: { bookingId: string; openedByUserId: string; status: 'open' | 'under_review' | 'resolved' | 'appealed' | 'closed' },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO disputes (booking_id, opened_by_user_id, reason, status, closed_at, idempotency_key, idempotency_fingerprint)
     VALUES ($1, $2, 'Spec 037 dashboard fixture dispute.', $3, CASE WHEN $3 = 'closed' THEN now() ELSE NULL END, $4, 'fp')
     RETURNING id`,
    [input.bookingId, input.openedByUserId, input.status, randomUUID()],
  );
  return rows[0]!.id;
}
