/**
 * Spec 037 §3 "Overview figures" and "Alert rules" (AC-1) — live transactional queries.
 *
 * Spec 040's `analytics_events` is still a column-less skeleton, so there is no aggregate to read
 * (D-6): each figure is ONE aggregate query at request time. Every query takes an `Executor`, so a
 * test can run it inside its own transaction snapshot; production passes `getDb()`.
 *
 * Nothing here writes, and nothing here returns a row-level value: counts and sums only (§4).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { SAFETY_READ_ACTION, SAFETY_RESOURCE } from '@/lib/safety/permissions';
import type { AdminAlertDto, AdminOverviewDto, MoneyAmountDto } from '@/lib/types/admin-dashboard';
import type { BookingStatus } from '@/lib/types/bookings';
import { ACTIVE_REQUEST_STATUSES } from '@/lib/types/requests';
import { holdsPermission, requireAnyAdminRole } from './access';

/** D-8 — every booking still in flight before completion. Spec 020 owns the vocabulary. */
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = [
  'pending',
  'confirmed',
  'provider_en_route',
  'arrived',
  'in_progress',
] as const;

export const SAFETY_QUEUE_LINK = '/admin/operations/safety';

function inList(values: readonly string[]) {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

/** `count(*)` of requests in spec 015's `ACTIVE_REQUEST_STATUSES` — imported, never copied. */
export async function countActiveRequests(db: Executor): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM requests WHERE status IN (${inList(ACTIVE_REQUEST_STATUSES)})`,
  );
  return row?.n ?? 0;
}

export async function countActiveBookings(db: Executor): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM bookings WHERE status IN (${inList(ACTIVE_BOOKING_STATUSES)})`,
  );
  return row?.n ?? 0;
}

/** The UTC calendar day containing `now`: `[00:00:00Z, next 00:00:00Z)` — spec 033's boundary. */
export function utcDayBounds(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * D-7 — the GROSS CAPTURED customer payment amount for the UTC calendar day containing `now`,
 * grouped by currency.
 *
 * - Membership is the `captured` transition in `payments_status_history` (spec 021): `created`,
 *   `requires_action`, `authorized` and `failed` payments have none, so they never count.
 * - `EXISTS`, not a join, so a payment is summed ONCE however many history rows it has.
 * - The payment's CURRENT status is deliberately not consulted: a payment captured today and
 *   refunded (fully or partially) later still counts its full charge — refunds are NOT subtracted.
 * - Not platform-fee revenue and not net revenue; those are spec 040's.
 * - Integer `sum` in SQL, never float (spec 003's money rule); `bigint` arrives as a string.
 */
export async function revenueForUtcDay(db: Executor, now: Date): Promise<MoneyAmountDto[]> {
  const { start, end } = utcDayBounds(now);
  const rows = await queryRows<{ currency_code: string; amount: string }>(
    db,
    sql`SELECT p.charge_currency_code AS currency_code, sum(p.charge_amount_minor_units)::bigint AS amount
          FROM payments p
         WHERE p.charge_amount_minor_units IS NOT NULL
           AND EXISTS (
                 SELECT 1 FROM payments_status_history h
                  WHERE h.payment_id = p.id
                    AND h.to_status = 'captured'
                    AND h.occurred_at >= ${start.toISOString()}::timestamptz
                    AND h.occurred_at < ${end.toISOString()}::timestamptz)
         GROUP BY p.charge_currency_code
         ORDER BY p.charge_currency_code`,
  );
  return rows.map((row) => ({ amountMinorUnits: Number(row.amount), currencyCode: row.currency_code }));
}

export async function countOpenCriticalSafetyReports(db: Executor): Promise<number> {
  const [row] = await queryRows<{ n: number }>(
    db,
    sql`SELECT count(*)::int AS n FROM safety_reports WHERE priority = 'critical' AND status <> 'resolved'`,
  );
  return row?.n ?? 0;
}

/** §3 "Rule critical_safety_reports" — the exact singular/plural message; never report content. */
export function criticalSafetyReportsMessage(count: number): string {
  return count === 1
    ? '1 critical safety report needs attention.'
    : `${count} critical safety reports need attention.`;
}

/**
 * The closed alert set (exactly one rule). One AGGREGATED alert carrying the count; absent when the
 * count is 0; omitted entirely — the query is not even run — for a caller without
 * `safety_reports`/`read`. Transient: recomputed per request, never stored.
 */
export async function alertsFor(db: Executor, userId: string): Promise<AdminAlertDto[]> {
  if (!(await holdsPermission(userId, SAFETY_RESOURCE, SAFETY_READ_ACTION))) return [];
  const count = await countOpenCriticalSafetyReports(db);
  if (count === 0) return [];
  return [
    {
      rule: 'critical_safety_reports',
      severity: 'critical',
      count,
      message: criticalSafetyReportsMessage(count),
      linkTo: SAFETY_QUEUE_LINK,
    },
  ];
}

/** `GET /api/v1/admin/overview` (AC-1, AC-6). Any admin role; aggregates are platform-wide (D-13). */
export async function getAdminOverview(
  userId: string,
  options: { db?: Executor; now?: Date } = {},
): Promise<AdminOverviewDto> {
  await requireAnyAdminRole(userId);
  const db = options.db ?? getDb();
  const now = options.now ?? new Date();

  // Sequential, not Promise.all: `db` may be one transaction client, which runs one query at a time.
  const activeRequests = await countActiveRequests(db);
  const activeBookings = await countActiveBookings(db);
  const revenueToday = await revenueForUtcDay(db, now);
  const alerts = await alertsFor(db, userId);

  return { activeRequests, activeBookings, revenueToday, alerts, generatedAt: now.toISOString() };
}
