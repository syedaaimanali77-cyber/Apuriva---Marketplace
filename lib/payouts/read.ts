/**
 * Spec 024 §3.3, §3.12, §3.13 — the read models.
 *
 * Every figure is a SUM over persisted integer columns, computed here, never on the client (AC-3).
 * Over the UNFILTERED summary both identities hold:
 *   net = gross − fee + adjustments − refunds
 *   pending + upcoming + paid = net
 * Provider queries are always scoped by the caller's own `provider_profile_id`, so another
 * provider's id is `404` by construction (AC-13).
 */
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { validationError } from '@/lib/api/errors';
import { buildPage, type PageParams } from '@/lib/api/pagination';
import { queryRows, type Executor } from '@/lib/offers/db';
import {
  isEarningsLineState,
  isPayoutStatus,
  type AdminPayoutDetailDto,
  type AdminPayoutDto,
  type EarningsAdjustmentDto,
  type EarningsLineDto,
  type EarningsSummaryDto,
  type PayoutDetailDto,
  type PayoutDto,
  type PayoutFailureCode,
  type PayoutItemDto,
  type PayoutStatus,
} from '@/lib/types/payouts';
import { payoutNotFoundError } from './errors';
import { findUsableDefaultMethod } from './ledger';
import { getPayoutHoldGate } from './ports';

/** The platform currency used only to label an all-zero summary for a provider with no ledger rows. */
const EMPTY_LEDGER_CURRENCY = 'PKR';

export interface DateRange {
  fromInstant: Date | null;
  toInstant: Date | null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Resolves inclusive local dates to instants in the provider's `scheduling_timezone` (spec 016's
 * authoritative zone), in PostgreSQL so DST is handled by the database's tz rules.
 */
export async function resolveDateRange(
  providerProfileId: string,
  from: string | null,
  to: string | null,
): Promise<DateRange> {
  if (from !== null && !isValidIsoDate(from)) throw validationError([{ field: 'from', message: 'must be a date (YYYY-MM-DD)' }]);
  if (to !== null && !isValidIsoDate(to)) throw validationError([{ field: 'to', message: 'must be a date (YYYY-MM-DD)' }]);
  if (from === null && to === null) return { fromInstant: null, toInstant: null };

  const [row] = await queryRows<{ from_at: Date | null; to_at: Date | null }>(
    getDb(),
    sql`SELECT CASE WHEN ${from}::text IS NULL THEN NULL
                    ELSE ((${from}::date)::timestamp AT TIME ZONE pp.scheduling_timezone) END AS from_at,
               CASE WHEN ${to}::text IS NULL THEN NULL
                    ELSE (((${to}::date) + 1)::timestamp AT TIME ZONE pp.scheduling_timezone) END AS to_at
          FROM provider_profiles pp WHERE pp.id = ${providerProfileId}`,
  );
  return { fromInstant: row?.from_at ?? null, toInstant: row?.to_at ?? null };
}

function inRange(column: SQL, range: DateRange): SQL {
  const lower = range.fromInstant ? sql` AND ${column} >= ${range.fromInstant}` : sql``;
  const upper = range.toInstant ? sql` AND ${column} < ${range.toInstant}` : sql``;
  return sql`${lower}${upper}`;
}

export async function availableCurrencies(providerProfileId: string, db: Executor = getDb()): Promise<string[]> {
  const rows = await queryRows<{ currency: string }>(
    db,
    sql`SELECT DISTINCT currency FROM (
          SELECT gross_currency_code AS currency FROM provider_earnings_lines WHERE provider_profile_id = ${providerProfileId}
          UNION SELECT adjustment_currency_code FROM earnings_adjustments WHERE provider_profile_id = ${providerProfileId} AND applied_at IS NOT NULL
          UNION SELECT payout_currency_code FROM payouts WHERE provider_profile_id = ${providerProfileId}
        ) s ORDER BY currency`,
  );
  return rows.map((row) => row.currency);
}

export function parseCurrency(value: string | null): string | null {
  if (value === null || value === '') return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw validationError([{ field: 'currency', message: 'must be a three-letter ISO-4217 code' }]);
  return code;
}

export interface SummaryFigures {
  grossAmountMinorUnits: number;
  feeAmountMinorUnits: number;
  refundsAmountMinorUnits: number;
  adjustmentsAmountMinorUnits: number;
  netAmountMinorUnits: number;
  pendingAmountMinorUnits: number;
  upcomingAmountMinorUnits: number;
  paidAmountMinorUnits: number;
}

/** The dashboard's exact queries — shared by the statement's TOTAL row so the two always agree. */
export async function summaryFigures(providerProfileId: string, currency: string, range: DateRange, db: Executor = getDb()): Promise<SummaryFigures> {
  const [lines] = await queryRows<{ gross: number; fee: number; refunds: number; pending: number; unattached: number }>(
    db,
    sql`SELECT COALESCE(SUM(l.gross_amount_minor_units), 0)::int AS gross,
               COALESCE(SUM(l.fee_amount_minor_units - l.fee_reversal_amount_minor_units), 0)::int AS fee,
               COALESCE(SUM(l.refunded_amount_minor_units), 0)::int AS refunds,
               COALESCE(SUM(l.net_amount_minor_units) FILTER (WHERE l.state = 'pending'
                 AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.earnings_line_id = l.id AND i.kind = 'earnings_line')), 0)::int AS pending,
               COALESCE(SUM(l.net_amount_minor_units) FILTER (WHERE l.state = 'eligible'
                 AND NOT EXISTS (SELECT 1 FROM payout_items i WHERE i.earnings_line_id = l.id AND i.kind = 'earnings_line')), 0)::int AS unattached
          FROM provider_earnings_lines l
         WHERE l.provider_profile_id = ${providerProfileId} AND l.gross_currency_code = ${currency}
           ${inRange(sql`l.created_at`, range)}`,
  );
  const [adjustments] = await queryRows<{ total: number; unattached: number }>(
    db,
    sql`SELECT COALESCE(SUM(a.adjustment_amount_minor_units), 0)::int AS total,
               COALESCE(SUM(a.adjustment_amount_minor_units) FILTER (WHERE NOT EXISTS
                 (SELECT 1 FROM payout_items i WHERE i.adjustment_id = a.id AND i.kind = 'adjustment')), 0)::int AS unattached
          FROM earnings_adjustments a
         WHERE a.provider_profile_id = ${providerProfileId} AND a.adjustment_currency_code = ${currency}
           AND a.applied_at IS NOT NULL ${inRange(sql`a.applied_at`, range)}`,
  );
  const [items] = await queryRows<{ open: number; paid: number }>(
    db,
    sql`SELECT COALESCE(SUM(i.item_amount_minor_units) FILTER (WHERE p.status <> 'paid'), 0)::int AS open,
               COALESCE(SUM(i.item_amount_minor_units) FILTER (WHERE p.status = 'paid'), 0)::int AS paid
          FROM payout_items i JOIN payouts p ON p.id = i.payout_id
         WHERE p.provider_profile_id = ${providerProfileId} AND p.payout_currency_code = ${currency}
           ${inRange(sql`i.created_at`, range)}`,
  );

  const gross = lines!.gross;
  const fee = lines!.fee;
  const refunds = lines!.refunds;
  const adjustmentsTotal = adjustments!.total;
  return {
    grossAmountMinorUnits: gross,
    feeAmountMinorUnits: fee,
    refundsAmountMinorUnits: refunds,
    adjustmentsAmountMinorUnits: adjustmentsTotal,
    netAmountMinorUnits: gross - fee + adjustmentsTotal - refunds,
    pendingAmountMinorUnits: lines!.pending,
    upcomingAmountMinorUnits: lines!.unattached + adjustments!.unattached + items!.open,
    paidAmountMinorUnits: items!.paid,
  };
}

export async function earningsSummary(
  providerProfileId: string,
  options: { currency: string | null; range: DateRange },
): Promise<EarningsSummaryDto> {
  const currencies = await availableCurrencies(providerProfileId);
  const currency = options.currency ?? currencies[0] ?? EMPTY_LEDGER_CURRENCY;
  const figures = await summaryFigures(providerProfileId, currency, options.range);
  const method = await findUsableDefaultMethod(getDb(), providerProfileId, currency);
  const hold = await getPayoutHoldGate()(getDb(), providerProfileId);

  return {
    currencyCode: currency,
    ...figures,
    balanceAmountMinorUnits: figures.upcomingAmountMinorUnits,
    payoutMethodRequired: method === null,
    payoutOnHold: hold.held,
    availableCurrencyCodes: currencies,
  };
}

interface LineRow {
  id: string;
  booking_id: string;
  service_id: string;
  state: EarningsLineDto['state'];
  gross_currency_code: string;
  gross_amount_minor_units: number;
  platform_fee_bps: number;
  fee_amount_minor_units: number;
  refunded_amount_minor_units: number;
  fee_reversal_amount_minor_units: number;
  net_amount_minor_units: number;
  scheduled_at: Date;
  eligible_at: Date | null;
  paid_at: Date | null;
  payout_id: string | null;
  created_at: Date;
  version: number;
}

const iso = (value: Date | null): string | null => (value ? new Date(value).toISOString() : null);

function toLineDto(row: LineRow): EarningsLineDto {
  return {
    id: row.id,
    bookingId: row.booking_id,
    serviceId: row.service_id,
    state: row.state,
    currencyCode: row.gross_currency_code,
    grossAmountMinorUnits: row.gross_amount_minor_units,
    platformFeeBps: row.platform_fee_bps,
    feeAmountMinorUnits: row.fee_amount_minor_units,
    refundedAmountMinorUnits: row.refunded_amount_minor_units,
    feeReversalAmountMinorUnits: row.fee_reversal_amount_minor_units,
    netAmountMinorUnits: row.net_amount_minor_units,
    scheduledAt: new Date(row.scheduled_at).toISOString(),
    eligibleAt: iso(row.eligible_at),
    paidAt: iso(row.paid_at),
    payoutId: row.payout_id,
    createdAt: new Date(row.created_at).toISOString(),
    version: row.version,
  };
}

export async function listEarningsLines(
  providerProfileId: string,
  options: { page: PageParams; state: string | null; currency: string | null; range: DateRange },
): Promise<{ data: EarningsLineDto[]; page: ReturnType<typeof buildPage> }> {
  if (options.state !== null && !isEarningsLineState(options.state)) {
    throw validationError([{ field: 'state', message: 'must be pending, eligible or paid' }]);
  }
  const where = sql`l.provider_profile_id = ${providerProfileId}
    ${options.state ? sql` AND l.state = ${options.state}` : sql``}
    ${options.currency ? sql` AND l.gross_currency_code = ${options.currency}` : sql``}
    ${inRange(sql`l.created_at`, options.range)}`;

  const [count] = await queryRows<{ total: number }>(getDb(), sql`SELECT COUNT(*)::int AS total FROM provider_earnings_lines l WHERE ${where}`);
  const rows = await queryRows<LineRow>(
    getDb(),
    sql`SELECT l.id, l.booking_id, l.service_id, l.state, l.gross_currency_code, l.gross_amount_minor_units,
               l.platform_fee_bps, l.fee_amount_minor_units, l.refunded_amount_minor_units,
               l.fee_reversal_amount_minor_units, l.net_amount_minor_units, b.scheduled_at, l.eligible_at,
               l.paid_at, i.payout_id, l.created_at, l.version
          FROM provider_earnings_lines l
          JOIN bookings b ON b.id = l.booking_id
          LEFT JOIN payout_items i ON i.earnings_line_id = l.id AND i.kind = 'earnings_line'
         WHERE ${where}
         ORDER BY l.eligible_at DESC NULLS LAST, l.created_at DESC, l.id
         LIMIT ${options.page.limit} OFFSET ${options.page.offset}`,
  );
  return { data: rows.map(toLineDto), page: buildPage(count!.total, options.page.limit, options.page.offset) };
}

interface PayoutRow {
  id: string;
  status: PayoutStatus;
  payout_amount_minor_units: number;
  payout_currency_code: string;
  item_count: number;
  masked_detail: string | null;
  closed_at: Date | null;
  paid_at: Date | null;
  failure_code: PayoutFailureCode | null;
  created_at: Date;
  version: number;
  provider_profile_id: string;
  attempt_count: number;
  payout_method_id: string | null;
  failure_reason: string | null;
  escalated_at: Date | null;
}

const PAYOUT_SELECT = sql`SELECT p.id, p.status, p.payout_amount_minor_units, p.payout_currency_code,
       (SELECT COUNT(*)::int FROM payout_items i WHERE i.payout_id = p.id) AS item_count,
       m.masked_detail, p.closed_at, p.paid_at, p.failure_code, p.created_at, p.version,
       p.provider_profile_id, p.attempt_count, p.payout_method_id, p.failure_reason, p.escalated_at
  FROM payouts p LEFT JOIN payout_methods m ON m.id = p.payout_method_id`;

function toPayoutDto(row: PayoutRow): PayoutDto {
  return {
    id: row.id,
    status: row.status,
    amountMinorUnits: row.payout_amount_minor_units,
    currencyCode: row.payout_currency_code,
    itemCount: row.item_count,
    payoutMethodMaskedDetail: row.masked_detail,
    closedAt: iso(row.closed_at),
    paidAt: iso(row.paid_at),
    failureCode: row.failure_code,
    createdAt: new Date(row.created_at).toISOString(),
    version: row.version,
  };
}

function toAdminPayoutDto(row: PayoutRow): AdminPayoutDto {
  return {
    ...toPayoutDto(row),
    providerProfileId: row.provider_profile_id,
    attemptCount: row.attempt_count,
    payoutMethodId: row.payout_method_id,
  };
}

async function loadItems(payoutId: string): Promise<PayoutItemDto[]> {
  const rows = await queryRows<{
    id: string;
    kind: PayoutItemDto['kind'];
    earnings_line_id: string | null;
    adjustment_id: string | null;
    booking_id: string | null;
    item_amount_minor_units: number;
    item_currency_code: string;
  }>(
    getDb(),
    sql`SELECT i.id, i.kind, i.earnings_line_id, i.adjustment_id, l.booking_id, i.item_amount_minor_units, i.item_currency_code
          FROM payout_items i LEFT JOIN provider_earnings_lines l ON l.id = i.earnings_line_id
         WHERE i.payout_id = ${payoutId} ORDER BY i.created_at ASC, i.id`,
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    earningsLineId: row.earnings_line_id,
    adjustmentId: row.adjustment_id,
    bookingId: row.booking_id,
    itemAmountMinorUnits: row.item_amount_minor_units,
    currencyCode: row.item_currency_code,
  }));
}

function parseStatus(status: string | null): PayoutStatus | null {
  if (status === null) return null;
  if (!isPayoutStatus(status)) throw validationError([{ field: 'status', message: 'is not a payout status' }]);
  return status;
}

export async function listProviderPayouts(
  providerProfileId: string,
  options: { page: PageParams; status: string | null },
): Promise<{ data: PayoutDto[]; page: ReturnType<typeof buildPage> }> {
  const status = parseStatus(options.status);
  const where = sql`p.provider_profile_id = ${providerProfileId} ${status ? sql` AND p.status = ${status}` : sql``}`;
  const [count] = await queryRows<{ total: number }>(getDb(), sql`SELECT COUNT(*)::int AS total FROM payouts p WHERE ${where}`);
  const rows = await queryRows<PayoutRow>(
    getDb(),
    sql`${PAYOUT_SELECT} WHERE ${where} ORDER BY p.created_at DESC, p.id LIMIT ${options.page.limit} OFFSET ${options.page.offset}`,
  );
  return { data: rows.map(toPayoutDto), page: buildPage(count!.total, options.page.limit, options.page.offset) };
}

export async function loadProviderPayoutDetail(providerProfileId: string, payoutId: string): Promise<PayoutDetailDto> {
  if (!/^[0-9a-f-]{36}$/i.test(payoutId)) throw payoutNotFoundError();
  const [row] = await queryRows<PayoutRow>(
    getDb(),
    sql`${PAYOUT_SELECT} WHERE p.id = ${payoutId} AND p.provider_profile_id = ${providerProfileId}`,
  );
  if (!row) throw payoutNotFoundError();
  return { ...toPayoutDto(row), items: await loadItems(payoutId) };
}

export async function listAdminPayouts(options: {
  page: PageParams;
  status: string | null;
  providerProfileId: string | null;
  range: DateRange;
}): Promise<{ data: AdminPayoutDto[]; page: ReturnType<typeof buildPage> }> {
  const status = parseStatus(options.status);
  if (options.providerProfileId !== null && !/^[0-9a-f-]{36}$/i.test(options.providerProfileId)) {
    throw validationError([{ field: 'providerProfileId', message: 'must be a uuid' }]);
  }
  const where = sql`true
    ${status ? sql` AND p.status = ${status}` : sql``}
    ${options.providerProfileId ? sql` AND p.provider_profile_id = ${options.providerProfileId}` : sql``}
    ${inRange(sql`p.created_at`, options.range)}`;
  const [count] = await queryRows<{ total: number }>(getDb(), sql`SELECT COUNT(*)::int AS total FROM payouts p WHERE ${where}`);
  const rows = await queryRows<PayoutRow>(
    getDb(),
    sql`${PAYOUT_SELECT} WHERE ${where}
         ORDER BY (p.status = 'failed' OR p.escalated_at IS NOT NULL) DESC, p.created_at DESC, p.id
         LIMIT ${options.page.limit} OFFSET ${options.page.offset}`,
  );
  return { data: rows.map(toAdminPayoutDto), page: buildPage(count!.total, options.page.limit, options.page.offset) };
}

export async function loadAdminPayoutDetail(payoutId: string): Promise<AdminPayoutDetailDto> {
  if (!/^[0-9a-f-]{36}$/i.test(payoutId)) throw payoutNotFoundError();
  const [row] = await queryRows<PayoutRow>(getDb(), sql`${PAYOUT_SELECT} WHERE p.id = ${payoutId}`);
  if (!row) throw payoutNotFoundError();
  return {
    ...toAdminPayoutDto(row),
    items: await loadItems(payoutId),
    failureReason: row.failure_reason,
    escalatedAt: iso(row.escalated_at),
  };
}

interface AdjustmentRow {
  id: string;
  kind: EarningsAdjustmentDto['kind'];
  adjustment_amount_minor_units: number;
  adjustment_currency_code: string;
  reason: string;
  admin_action_id: string;
  provider_profile_id: string;
  applied_at: Date | null;
  payout_id: string | null;
  created_at: Date;
}

export const ADJUSTMENT_SELECT = sql`SELECT a.id, a.kind, a.adjustment_amount_minor_units, a.adjustment_currency_code, a.reason,
       a.admin_action_id, a.provider_profile_id, a.applied_at, i.payout_id, a.created_at
  FROM earnings_adjustments a LEFT JOIN payout_items i ON i.adjustment_id = a.id AND i.kind = 'adjustment'`;

export function toAdjustmentDto(row: AdjustmentRow, surface: 'admin' | 'provider'): EarningsAdjustmentDto {
  const dto: EarningsAdjustmentDto = {
    id: row.id,
    kind: row.kind,
    adjustmentAmountMinorUnits: row.adjustment_amount_minor_units,
    currencyCode: row.adjustment_currency_code,
    reason: row.reason,
    appliedAt: iso(row.applied_at),
    payoutId: row.payout_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
  if (surface === 'admin') {
    dto.adminActionId = row.admin_action_id;
    dto.providerProfileId = row.provider_profile_id;
  }
  return dto;
}

export async function loadAdjustmentRow(adjustmentId: string, db: Executor = getDb()): Promise<AdjustmentRow | undefined> {
  const [row] = await queryRows<AdjustmentRow>(db, sql`${ADJUSTMENT_SELECT} WHERE a.id = ${adjustmentId}`);
  return row;
}

export async function listAdminAdjustments(options: {
  page: PageParams;
  providerProfileId: string | null;
  applied: string | null;
}): Promise<{ data: EarningsAdjustmentDto[]; page: ReturnType<typeof buildPage> }> {
  if (options.providerProfileId !== null && !/^[0-9a-f-]{36}$/i.test(options.providerProfileId)) {
    throw validationError([{ field: 'providerProfileId', message: 'must be a uuid' }]);
  }
  if (options.applied !== null && options.applied !== 'true' && options.applied !== 'false') {
    throw validationError([{ field: 'applied', message: 'must be true or false' }]);
  }
  const where = sql`true
    ${options.providerProfileId ? sql` AND a.provider_profile_id = ${options.providerProfileId}` : sql``}
    ${options.applied === 'true' ? sql` AND a.applied_at IS NOT NULL` : options.applied === 'false' ? sql` AND a.applied_at IS NULL` : sql``}`;
  const [count] = await queryRows<{ total: number }>(getDb(), sql`SELECT COUNT(*)::int AS total FROM earnings_adjustments a WHERE ${where}`);
  const rows = await queryRows<AdjustmentRow>(
    getDb(),
    sql`${ADJUSTMENT_SELECT} WHERE ${where} ORDER BY a.created_at DESC, a.id LIMIT ${options.page.limit} OFFSET ${options.page.offset}`,
  );
  return { data: rows.map((row) => toAdjustmentDto(row, 'admin')), page: buildPage(count!.total, options.page.limit, options.page.offset) };
}

/** Applied adjustments only — a provider never sees an unapproved row (§3.10). */
export async function listProviderAdjustments(providerProfileId: string, currency: string | null): Promise<EarningsAdjustmentDto[]> {
  const rows = await queryRows<AdjustmentRow>(
    getDb(),
    sql`${ADJUSTMENT_SELECT} WHERE a.provider_profile_id = ${providerProfileId} AND a.applied_at IS NOT NULL
          ${currency ? sql` AND a.adjustment_currency_code = ${currency}` : sql``}
         ORDER BY a.applied_at DESC`,
  );
  return rows.map((row) => toAdjustmentDto(row, 'provider'));
}
