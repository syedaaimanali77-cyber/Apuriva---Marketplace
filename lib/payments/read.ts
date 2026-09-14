/**
 * Spec 021 §3 "AI and MCP boundary" (AC-8) — the single read-only projection of payment state.
 *
 * Master spec §132.7: "Do not claim a payment succeeded without backend/payment-provider
 * confirmation." Spec 033's assistant and spec 036's tool catalog do not exist yet, so this spec
 * ships the MECHANISM they will consume rather than a stub of them: every consumer that reports a
 * payment outcome to a person — the UI, the AI, an MCP tool — reads `loadPaymentDto()`.
 *
 * The rules this module holds to, asserted at source level by `no-fabricated-success.test.ts`:
 *   - every field is a projection of a persisted column. There is no branch that derives, infers or
 *     optimistically reports a status the database does not hold, and no default that could read as
 *     success — an absent payment is `null`/`404`, never a synthesized "pending" or "ok".
 *   - `provider_reference`, `provider_name`, `idempotency_key` and `idempotency_fingerprint` are
 *     never selected into a DTO. They are internal reconciliation handles (§4 "Retention and
 *     privacy"), and the SQL below simply does not read them.
 *
 * PARTICIPATION is resolved through spec 020's `requireBookingParticipant`, so a non-participant
 * gets `404` — never `403` — and booking ids cannot be probed (specs 015/018/019/020's rule).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import { requireBookingParticipant } from '@/lib/bookings';
import type {
  PaymentDto,
  PaymentProtectionState,
  PaymentStatus,
  PriceAdjustmentDto,
  PriceAdjustmentStatus,
} from '@/lib/types/payments';
import { paymentNotFoundError } from './errors';
import { protectionWindowEndsAt } from './protection-window';

interface PaymentRow {
  id: string;
  booking_id: string;
  status: PaymentStatus;
  charge_amount_minor_units: number;
  charge_currency_code: string;
  protection_state: PaymentProtectionState | null;
  protection_window_started_at: Date | null;
  protection_window_hours: number;
  created_at: Date;
  updated_at: Date;
  version: number;
}

/**
 * The columns a DTO may be built from. `provider_reference`, `provider_name` and the idempotency
 * columns are deliberately absent from this list — not filtered out later, simply never read.
 */
const PAYMENT_DTO_COLUMNS = sql`p.id, p.booking_id, p.status, p.charge_amount_minor_units, p.charge_currency_code,
  p.protection_state, p.protection_window_started_at, p.protection_window_hours,
  p.created_at, p.updated_at, p.version`;

export function toPaymentDto(row: PaymentRow): PaymentDto {
  const startedAt = row.protection_window_started_at === null ? null : new Date(row.protection_window_started_at);
  const endsAt = protectionWindowEndsAt(startedAt, row.protection_window_hours);
  return {
    id: row.id,
    bookingId: row.booking_id,
    status: row.status,
    chargeAmountMinorUnits: row.charge_amount_minor_units,
    chargeCurrencyCode: row.charge_currency_code,
    protectionState: row.protection_state,
    protectionWindowStartedAt: startedAt === null ? null : startedAt.toISOString(),
    protectionWindowHours: row.protection_window_hours,
    protectionWindowEndsAt: endsAt === null ? null : endsAt.toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    version: row.version,
  };
}

/** The payment for a booking, or `null` when none exists yet. Never a synthesized placeholder. */
export async function findPaymentByBookingId(bookingId: string, tx?: Executor): Promise<PaymentDto | null> {
  if (!isUuid(bookingId)) return null;
  const [row] = await queryRows<PaymentRow>(
    tx ?? getDb(),
    sql`SELECT ${PAYMENT_DTO_COLUMNS} FROM payments p WHERE p.booking_id = ${bookingId}`,
  );
  return row ? toPaymentDto(row) : null;
}

/**
 * AC-8 — the projection every consumer reports from.
 *
 * Authorization first: the caller must be a participant on the booking, in a matching active mode.
 * A stranger and a missing payment are indistinguishable.
 */
export async function loadPaymentDto(
  userId: string,
  bookingId: string,
  actingAs: 'customer' | 'provider',
): Promise<PaymentDto> {
  await requireBookingParticipant(userId, bookingId, actingAs);
  const payment = await findPaymentByBookingId(bookingId);
  if (!payment) throw paymentNotFoundError();
  return payment;
}

interface PriceAdjustmentRow {
  id: string;
  booking_id: string;
  additional_amount_minor_units: number;
  additional_currency_code: string;
  reason: string;
  status: PriceAdjustmentStatus;
  approved_at: Date | null;
  created_at: Date;
  version: number;
}

const ADJUSTMENT_DTO_COLUMNS = sql`a.id, a.booking_id, a.additional_amount_minor_units, a.additional_currency_code,
  a.reason, a.status, a.approved_at, a.created_at, a.version`;

export function toPriceAdjustmentDto(row: PriceAdjustmentRow): PriceAdjustmentDto {
  return {
    id: row.id,
    bookingId: row.booking_id,
    additionalAmountMinorUnits: row.additional_amount_minor_units,
    additionalCurrencyCode: row.additional_currency_code,
    reason: row.reason,
    status: row.status,
    approvedAt: row.approved_at === null ? null : new Date(row.approved_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    version: row.version,
  };
}

export async function loadPriceAdjustmentDto(adjustmentId: string, tx?: Executor): Promise<PriceAdjustmentDto> {
  if (!isUuid(adjustmentId)) throw paymentNotFoundError();
  const [row] = await queryRows<PriceAdjustmentRow>(
    tx ?? getDb(),
    sql`SELECT ${ADJUSTMENT_DTO_COLUMNS} FROM price_adjustments a WHERE a.id = ${adjustmentId}`,
  );
  if (!row) throw paymentNotFoundError();
  return toPriceAdjustmentDto(row);
}

/** Every adjustment on a booking the caller participates in, newest first. */
export async function listPriceAdjustments(
  userId: string,
  bookingId: string,
  actingAs: 'customer' | 'provider',
): Promise<PriceAdjustmentDto[]> {
  await requireBookingParticipant(userId, bookingId, actingAs);
  const rows = await queryRows<PriceAdjustmentRow>(
    getDb(),
    sql`SELECT ${ADJUSTMENT_DTO_COLUMNS} FROM price_adjustments a
         WHERE a.booking_id = ${bookingId}
         ORDER BY a.created_at DESC`,
  );
  return rows.map(toPriceAdjustmentDto);
}

/**
 * Resolves the booking behind an adjustment and the caller's participation on it, or `404`.
 * Used by the approve/reject routes, which address the adjustment rather than the booking.
 */
export async function requireAdjustmentParticipant(
  userId: string,
  adjustmentId: string,
  actingAs: 'customer' | 'provider',
): Promise<{ adjustment: PriceAdjustmentDto; bookingId: string }> {
  const adjustment = await loadPriceAdjustmentDto(adjustmentId);
  await requireBookingParticipant(userId, adjustment.bookingId, actingAs).catch(() => {
    throw paymentNotFoundError();
  });
  return { adjustment, bookingId: adjustment.bookingId };
}
