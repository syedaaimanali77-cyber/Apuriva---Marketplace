/**
 * Spec 024 §3.11 "Statement export" (AC-6) — synchronous, bounded CSV.
 *
 * Not an async job and not a second export framework: spec 008's async pipeline needs spec 027's
 * `FileAssetStorage`, which throws until spec 027 ships. Nothing is stored, so there is no artifact,
 * expiry or download token to leak.
 *
 * The TOTAL row is computed with the dashboard's exact queries (`summaryFigures`) restricted to the
 * same range and currency, so the two surfaces always agree.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { statementMaxRangeDays, statementMaxRows } from './config';
import { statementCurrencyRequiredError, statementRangeInvalidError, statementRangeTooLargeError } from './errors';
import { availableCurrencies, isValidIsoDate, parseCurrency, resolveDateRange, summaryFigures } from './read';

export const STATEMENT_COLUMNS = [
  'row_type',
  'booking_id',
  'service_id',
  'scheduled_at',
  'eligible_at',
  'gross_amount_minor_units',
  'platform_fee_bps',
  'fee_amount_minor_units',
  'refunded_amount_minor_units',
  'fee_reversal_amount_minor_units',
  'net_amount_minor_units',
  'currency_code',
  'adjustment_kind',
  'adjustment_reason',
  'item_amount_minor_units',
  'payout_id',
  'payout_status',
  'payout_paid_at',
  'total_adjustments_amount_minor_units',
  'total_pending_amount_minor_units',
  'total_upcoming_amount_minor_units',
  'total_paid_amount_minor_units',
] as const;

type Column = (typeof STATEMENT_COLUMNS)[number];
type CsvRow = Partial<Record<Column, string | number | null>>;

/** RFC 4180 quoting, plus spreadsheet formula neutralisation for free-text cells. */
function cell(value: string | number | null | undefined, freeText = false): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (freeText && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const iso = (value: Date | null): string | null => (value ? new Date(value).toISOString() : null);

export interface StatementResult {
  filename: string;
  body: string;
}

export async function buildStatement(
  providerProfileId: string,
  params: { from: string | null; to: string | null; currency: string | null },
): Promise<StatementResult> {
  const maxDays = statementMaxRangeDays();
  if (!params.from || !params.to || !isValidIsoDate(params.from) || !isValidIsoDate(params.to)) {
    throw statementRangeInvalidError(maxDays);
  }
  const days = (Date.parse(`${params.to}T00:00:00Z`) - Date.parse(`${params.from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days < 1 || days > maxDays) throw statementRangeInvalidError(maxDays);

  const currencies = await availableCurrencies(providerProfileId);
  let currency = parseCurrency(params.currency);
  if (!currency) {
    if (currencies.length > 1) throw statementCurrencyRequiredError();
    currency = currencies[0] ?? 'PKR';
  }

  const range = await resolveDateRange(providerProfileId, params.from, params.to);

  const lines = await queryRows<{
    booking_id: string;
    service_id: string;
    scheduled_at: Date;
    eligible_at: Date | null;
    gross_amount_minor_units: number;
    platform_fee_bps: number;
    fee_amount_minor_units: number;
    refunded_amount_minor_units: number;
    fee_reversal_amount_minor_units: number;
    net_amount_minor_units: number;
    payout_id: string | null;
    payout_status: string | null;
    payout_paid_at: Date | null;
  }>(
    getDb(),
    sql`SELECT l.booking_id, l.service_id, b.scheduled_at, l.eligible_at, l.gross_amount_minor_units, l.platform_fee_bps,
               l.fee_amount_minor_units, l.refunded_amount_minor_units, l.fee_reversal_amount_minor_units,
               l.net_amount_minor_units, p.id AS payout_id, p.status AS payout_status, p.paid_at AS payout_paid_at
          FROM provider_earnings_lines l
          JOIN bookings b ON b.id = l.booking_id
          LEFT JOIN payout_items i ON i.earnings_line_id = l.id AND i.kind = 'earnings_line'
          LEFT JOIN payouts p ON p.id = i.payout_id
         WHERE l.provider_profile_id = ${providerProfileId} AND l.gross_currency_code = ${currency}
           AND l.created_at >= ${range.fromInstant} AND l.created_at < ${range.toInstant}
         ORDER BY l.created_at ASC, l.id`,
  );
  const adjustments = await queryRows<{
    kind: string;
    reason: string;
    adjustment_amount_minor_units: number;
    payout_id: string | null;
    payout_status: string | null;
    payout_paid_at: Date | null;
  }>(
    getDb(),
    sql`SELECT a.kind, a.reason, a.adjustment_amount_minor_units, p.id AS payout_id, p.status AS payout_status, p.paid_at AS payout_paid_at
          FROM earnings_adjustments a
          LEFT JOIN payout_items i ON i.adjustment_id = a.id AND i.kind = 'adjustment'
          LEFT JOIN payouts p ON p.id = i.payout_id
         WHERE a.provider_profile_id = ${providerProfileId} AND a.adjustment_currency_code = ${currency}
           AND a.applied_at IS NOT NULL AND a.applied_at >= ${range.fromInstant} AND a.applied_at < ${range.toInstant}
         ORDER BY a.applied_at ASC, a.id`,
  );
  const recoveries = await queryRows<{
    booking_id: string;
    item_amount_minor_units: number;
    payout_id: string;
    payout_status: string;
    payout_paid_at: Date | null;
  }>(
    getDb(),
    sql`SELECT l.booking_id, i.item_amount_minor_units, p.id AS payout_id, p.status AS payout_status, p.paid_at AS payout_paid_at
          FROM payout_items i
          JOIN payouts p ON p.id = i.payout_id
          JOIN provider_earnings_lines l ON l.id = i.earnings_line_id
         WHERE i.kind = 'refund_recovery' AND p.provider_profile_id = ${providerProfileId} AND p.payout_currency_code = ${currency}
           AND i.created_at >= ${range.fromInstant} AND i.created_at < ${range.toInstant}
         ORDER BY i.created_at ASC, i.id`,
  );

  const maxRows = statementMaxRows();
  if (lines.length + adjustments.length + recoveries.length > maxRows) throw statementRangeTooLargeError(maxRows);

  const rows: string[] = [STATEMENT_COLUMNS.join(',')];
  const push = (row: CsvRow) =>
    rows.push(STATEMENT_COLUMNS.map((column) => cell(row[column], column === 'adjustment_reason' || column === 'adjustment_kind')).join(','));

  for (const line of lines) {
    push({
      row_type: 'earnings_line',
      booking_id: line.booking_id,
      service_id: line.service_id,
      scheduled_at: iso(line.scheduled_at),
      eligible_at: iso(line.eligible_at),
      gross_amount_minor_units: line.gross_amount_minor_units,
      platform_fee_bps: line.platform_fee_bps,
      fee_amount_minor_units: line.fee_amount_minor_units,
      refunded_amount_minor_units: line.refunded_amount_minor_units,
      fee_reversal_amount_minor_units: line.fee_reversal_amount_minor_units,
      net_amount_minor_units: line.net_amount_minor_units,
      currency_code: currency,
      payout_id: line.payout_id,
      payout_status: line.payout_status,
      payout_paid_at: iso(line.payout_paid_at),
    });
  }
  for (const adjustment of adjustments) {
    push({
      row_type: 'adjustment',
      currency_code: currency,
      adjustment_kind: adjustment.kind,
      adjustment_reason: adjustment.reason,
      item_amount_minor_units: adjustment.adjustment_amount_minor_units,
      payout_id: adjustment.payout_id,
      payout_status: adjustment.payout_status,
      payout_paid_at: iso(adjustment.payout_paid_at),
    });
  }
  for (const recovery of recoveries) {
    push({
      row_type: 'refund_recovery',
      booking_id: recovery.booking_id,
      currency_code: currency,
      item_amount_minor_units: recovery.item_amount_minor_units,
      payout_id: recovery.payout_id,
      payout_status: recovery.payout_status,
      payout_paid_at: iso(recovery.payout_paid_at),
    });
  }

  const totals = await summaryFigures(providerProfileId, currency, range);
  push({
    row_type: 'TOTAL',
    gross_amount_minor_units: totals.grossAmountMinorUnits,
    fee_amount_minor_units: totals.feeAmountMinorUnits,
    refunded_amount_minor_units: totals.refundsAmountMinorUnits,
    net_amount_minor_units: totals.netAmountMinorUnits,
    currency_code: currency,
    total_adjustments_amount_minor_units: totals.adjustmentsAmountMinorUnits,
    total_pending_amount_minor_units: totals.pendingAmountMinorUnits,
    total_upcoming_amount_minor_units: totals.upcomingAmountMinorUnits,
    total_paid_amount_minor_units: totals.paidAmountMinorUnits,
  });

  return {
    filename: `earnings-statement-${params.from}-${params.to}-${currency}.csv`,
    body: `${rows.join('\r\n')}\r\n`,
  };
}
