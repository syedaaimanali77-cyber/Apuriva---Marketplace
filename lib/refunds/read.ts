/**
 * Spec 022 §3 — the refund read surface.
 *
 * `RefundDto` is a projection of persisted columns only. The SQL below simply never selects
 * `provider_reference`, `refund_reference`, `failure_code`, `failure_reason`, `idempotency_key`,
 * `idempotency_fingerprint`, `initiated_by_user_id` or `eligibility_decision_ref` — they are
 * reconciliation and security data, not the customer's (§4 "Retention and privacy"), and
 * `no-policy-leak.test.ts` asserts they never cross this boundary.
 *
 * `adminActionId` is included ONLY when the caller is reading through the admin surface, which is
 * the one place the approval chain is legitimately visible.
 *
 * PARTICIPATION is resolved through spec 020's `requireBookingParticipant`, so a non-participant
 * gets `404` — never `403` — and ids cannot be probed.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import { requireBookingParticipant } from '@/lib/bookings';
import type { PageParams } from '@/lib/api/pagination';
import type {
  RefundDto,
  RefundLineDto,
  RefundReconciliationState,
  RefundSource,
  RefundStatus,
} from '@/lib/types/refunds';
import { refundNotFoundError } from './errors';

interface RefundRow {
  id: string;
  booking_id: string;
  payment_id: string;
  status: RefundStatus;
  total_amount_minor_units: number;
  total_currency_code: string;
  source: RefundSource;
  is_override: boolean;
  admin_action_id: string | null;
  reconciliation_state: RefundReconciliationState;
  completed_at: Date | null;
  created_at: Date;
  version: number;
}

interface LineRow {
  id: string;
  refund_id: string;
  line_amount_minor_units: number;
  line_currency_code: string;
  reason: string;
  created_at: Date;
}

/**
 * The columns a DTO may be built from. The provider/idempotency/actor columns are deliberately
 * absent from this list — not filtered out later, simply never read.
 */
const REFUND_DTO_COLUMNS = sql`r.id, r.booking_id, r.payment_id, r.status, r.total_amount_minor_units,
  r.total_currency_code, r.source, r.is_override, r.admin_action_id, r.reconciliation_state,
  r.completed_at, r.created_at, r.version`;

function toDto(row: RefundRow, lines: RefundLineDto[], options: { includeAdminAction: boolean }): RefundDto {
  const dto: RefundDto = {
    id: row.id,
    bookingId: row.booking_id,
    paymentId: row.payment_id,
    status: row.status,
    totalAmountMinorUnits: row.total_amount_minor_units,
    totalCurrencyCode: row.total_currency_code,
    lines,
    source: row.source,
    isOverride: row.is_override,
    reconciliationState: row.reconciliation_state,
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    version: row.version,
  };
  // The approval chain is admin data. A participant response never carries it.
  if (options.includeAdminAction && row.admin_action_id !== null) dto.adminActionId = row.admin_action_id;
  return dto;
}

async function linesFor(tx: Executor, refundIds: readonly string[]): Promise<Map<string, RefundLineDto[]>> {
  const byRefund = new Map<string, RefundLineDto[]>();
  if (refundIds.length === 0) return byRefund;

  const rows = await queryRows<LineRow>(
    tx,
    sql`SELECT l.id, l.refund_id, l.line_amount_minor_units, l.line_currency_code, l.reason, l.created_at
          FROM refund_lines l
         WHERE l.refund_id IN (${sql.join(refundIds.map((id) => sql`${id}`), sql`, `)})
         ORDER BY l.created_at ASC, l.id ASC`,
  );

  for (const row of rows) {
    const list = byRefund.get(row.refund_id) ?? [];
    list.push({
      id: row.id,
      lineAmountMinorUnits: row.line_amount_minor_units,
      lineCurrencyCode: row.line_currency_code,
      reason: row.reason,
    });
    byRefund.set(row.refund_id, list);
  }
  return byRefund;
}

async function hydrate(
  tx: Executor,
  rows: RefundRow[],
  options: { includeAdminAction: boolean },
): Promise<RefundDto[]> {
  const lines = await linesFor(tx, rows.map((row) => row.id));
  return rows.map((row) => toDto(row, lines.get(row.id) ?? [], options));
}

/** One refund by id, or `404`. Used by the sweep and the admin surface. */
export async function loadRefundDto(
  refundId: string,
  options?: { includeAdminAction?: boolean; tx?: Executor },
): Promise<RefundDto> {
  if (!isUuid(refundId)) throw refundNotFoundError();
  const tx = options?.tx ?? getDb();
  const rows = await queryRows<RefundRow>(tx, sql`SELECT ${REFUND_DTO_COLUMNS} FROM refunds r WHERE r.id = ${refundId}`);
  if (rows.length === 0) throw refundNotFoundError();
  const [dto] = await hydrate(tx, rows, { includeAdminAction: options?.includeAdminAction ?? false });
  return dto!;
}

/**
 * Every refund on a booking the caller participates in, newest first.
 *
 * Open to either participant in their own mode: the provider legitimately needs to know a refund
 * happened and for how much, and sees no provider reference or failure code either way.
 */
export async function listRefundsForBooking(
  userId: string,
  bookingId: string,
  actingAs: 'customer' | 'provider',
): Promise<RefundDto[]> {
  await requireBookingParticipant(userId, bookingId, actingAs);
  const rows = await queryRows<RefundRow>(
    getDb(),
    sql`SELECT ${REFUND_DTO_COLUMNS} FROM refunds r WHERE r.booking_id = ${bookingId} ORDER BY r.created_at DESC`,
  );
  return hydrate(getDb(), rows, { includeAdminAction: false });
}

/** Refunds on a booking, without an authorization check — for internal/domain callers only. */
export async function listRefundsForBookingUnchecked(bookingId: string, tx?: Executor): Promise<RefundDto[]> {
  const executor = tx ?? getDb();
  const rows = await queryRows<RefundRow>(
    executor,
    sql`SELECT ${REFUND_DTO_COLUMNS} FROM refunds r WHERE r.booking_id = ${bookingId} ORDER BY r.created_at DESC`,
  );
  return hydrate(executor, rows, { includeAdminAction: false });
}

export interface AdminRefundFilters {
  status?: RefundStatus;
  reconciliationState?: RefundReconciliationState;
}

/** The admin listing — paged with spec 004's shared helpers, and the one surface showing `adminActionId`. */
export async function listRefundsForAdmin(
  filters: AdminRefundFilters,
  page: PageParams,
): Promise<{ items: RefundDto[]; total: number }> {
  const statusFilter = filters.status ? sql` AND r.status = ${filters.status}` : sql``;
  const reconciliationFilter = filters.reconciliationState
    ? sql` AND r.reconciliation_state = ${filters.reconciliationState}`
    : sql``;

  const [countRow] = await queryRows<{ total: string }>(
    getDb(),
    sql`SELECT COUNT(*)::text AS total FROM refunds r WHERE TRUE${statusFilter}${reconciliationFilter}`,
  );

  const rows = await queryRows<RefundRow>(
    getDb(),
    sql`SELECT ${REFUND_DTO_COLUMNS} FROM refunds r
         WHERE TRUE${statusFilter}${reconciliationFilter}
         ORDER BY r.created_at DESC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );

  return { items: await hydrate(getDb(), rows, { includeAdminAction: true }), total: Number(countRow?.total ?? 0) };
}

/** The refund's status history — attribution, for admin/audit surfaces. */
export async function loadRefundStatusHistory(refundId: string) {
  return queryRows<{
    from_status: RefundStatus | null;
    to_status: RefundStatus;
    actor_role: string;
    detail: string | null;
    occurred_at: Date;
  }>(
    getDb(),
    sql`SELECT from_status, to_status, actor_role, detail, occurred_at
          FROM refunds_status_history
         WHERE refund_id = ${refundId}
         ORDER BY occurred_at ASC, created_at ASC`,
  );
}
