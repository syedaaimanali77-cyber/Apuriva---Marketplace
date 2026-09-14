/**
 * Spec 020 §3 — the booking read surface, and the participant resolution every mutation shares.
 *
 * PARTICIPATION is always resolved server-side from `session.userId` through
 * `customer_profiles`/`provider_profiles`. No route accepts a profile id from the client, so none
 * has an IDOR surface. A caller who is not a participant gets `404 BOOKING_NOT_FOUND` — never
 * `403` — so booking ids cannot be probed by observing a different status (spec 015/018/019's rule).
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import type {
  BookingActorRole,
  BookingDto,
  BookingListFilter,
  BookingStatus,
  BookingStatusHistoryDto,
  BookingSummaryDto,
} from '@/lib/types/bookings';
import { bookingNotFoundError } from './errors';

interface BookingRow {
  id: string;
  request_id: string;
  offer_id: string;
  service_id: string;
  customer_profile_id: string;
  provider_profile_id: string;
  status: BookingStatus;
  scheduled_at: Date;
  scheduled_timezone: string;
  duration_minutes: number;
  price_amount_minor_units: number;
  price_currency_code: string;
  address_id: string;
  created_at: Date;
  updated_at: Date;
  version: number;
}

function toDto(row: BookingRow): BookingDto {
  return {
    id: row.id,
    requestId: row.request_id,
    offerId: row.offer_id,
    serviceId: row.service_id,
    customerProfileId: row.customer_profile_id,
    providerProfileId: row.provider_profile_id,
    status: row.status,
    scheduledAt: new Date(row.scheduled_at).toISOString(),
    scheduledTimezone: row.scheduled_timezone,
    durationMinutes: row.duration_minutes,
    priceAmountMinorUnits: row.price_amount_minor_units,
    currencyCode: row.price_currency_code,
    addressId: row.address_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    version: row.version,
  };
}

const BOOKING_COLUMNS = sql`b.id, b.request_id, b.offer_id, b.service_id, b.customer_profile_id,
  b.provider_profile_id, b.status, b.scheduled_at, b.scheduled_timezone, b.duration_minutes,
  b.price_amount_minor_units, b.price_currency_code, b.address_id, b.created_at, b.updated_at, b.version`;

export async function loadBookingDto(bookingId: string, tx?: Executor): Promise<BookingDto> {
  const [row] = await queryRows<BookingRow>(tx ?? getDb(), sql`SELECT ${BOOKING_COLUMNS} FROM bookings b WHERE b.id = ${bookingId}`);
  if (!row) throw bookingNotFoundError();
  return toDto(row);
}

/** Which party the session user is on this booking — the basis of every authorization decision. */
export interface BookingParticipation {
  booking: BookingDto;
  /** 'customer' or 'provider'. A user who is somehow both resolves as whichever their mode says. */
  role: Extract<BookingActorRole, 'customer' | 'provider'>;
  isCustomer: boolean;
  isProvider: boolean;
}

/**
 * Resolves the caller's participation, or throws `404`.
 *
 * `preferRole` lets the completion route (the one route open to either mode) pick the role matching
 * the caller's ACTIVE MODE, so a user who holds both a customer and a provider profile on one
 * booking can never produce an ambiguous `actor_role` (§3 "Authorization matrix"). When the caller
 * is not that party, participation resolution fails — the party simply has to be in their own mode.
 */
export async function requireBookingParticipant(
  userId: string,
  bookingId: string,
  preferRole?: 'customer' | 'provider',
  tx?: Executor,
): Promise<BookingParticipation> {
  if (!isUuid(bookingId)) throw bookingNotFoundError();

  const [row] = await queryRows<BookingRow & { is_customer: boolean; is_provider: boolean }>(
    tx ?? getDb(),
    sql`SELECT ${BOOKING_COLUMNS},
               (cp.user_id = ${userId}) AS is_customer,
               (pp.user_id = ${userId}) AS is_provider
          FROM bookings b
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE b.id = ${bookingId} AND (cp.user_id = ${userId} OR pp.user_id = ${userId})`,
  );
  if (!row) throw bookingNotFoundError();

  const isCustomer = Boolean(row.is_customer);
  const isProvider = Boolean(row.is_provider);

  if (preferRole === 'customer' && !isCustomer) throw bookingNotFoundError();
  if (preferRole === 'provider' && !isProvider) throw bookingNotFoundError();

  const role = preferRole ?? (isCustomer ? 'customer' : 'provider');
  return { booking: toDto(row), role, isCustomer, isProvider };
}

export async function loadBookingStatusHistory(bookingId: string): Promise<BookingStatusHistoryDto[]> {
  const rows = await queryRows<{
    from_status: BookingStatus | null;
    to_status: BookingStatus;
    actor_role: BookingActorRole;
    occurred_at: Date;
  }>(
    getDb(),
    sql`SELECT from_status, to_status, actor_role, occurred_at
          FROM bookings_status_history
         WHERE booking_id = ${bookingId}
         ORDER BY occurred_at ASC, created_at ASC`,
  );

  // `actor_user_id` is deliberately NOT selected: §4 forbids exposing a counterparty user id.
  return rows.map((row) => ({
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorRole: row.actor_role,
    occurredAt: new Date(row.occurred_at).toISOString(),
  }));
}

/** The statuses each list filter covers. `upcoming`/`active` split the live lifecycle. */
const FILTER_STATUSES: Record<BookingListFilter, readonly BookingStatus[]> = {
  upcoming: ['pending', 'confirmed'],
  active: ['provider_en_route', 'arrived', 'in_progress'],
  completed: ['completed', 'protected', 'settled'],
  cancelled: ['cancelled', 'refunded', 'failed'],
  disputed: ['disputed'],
};

export const BOOKING_LIST_FILTERS = Object.keys(FILTER_STATUSES) as BookingListFilter[];

export function isBookingListFilter(value: unknown): value is BookingListFilter {
  return typeof value === 'string' && value in FILTER_STATUSES;
}

/**
 * The caller's own bookings for their ACTIVE MODE — the mode selects the role, it is never inferred.
 * A caller with no profile for that mode gets an empty page rather than another user's rows.
 */
export async function listBookings(
  userId: string,
  mode: 'customer' | 'provider',
  options: { filter?: BookingListFilter; limit: number; offset: number },
): Promise<{ data: BookingSummaryDto[]; total: number }> {
  const statuses = options.filter ? FILTER_STATUSES[options.filter] : null;
  const ownership =
    mode === 'customer'
      ? sql`cp.user_id = ${userId}`
      : sql`pp.user_id = ${userId}`;
  const statusFilter = statuses
    ? sql` AND b.status IN (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})`
    : sql``;

  const rows = await queryRows<{
    id: string;
    status: BookingStatus;
    scheduled_at: Date;
    scheduled_timezone: string;
    service_name: string;
    counterparty_name: string | null;
    price_amount_minor_units: number;
    price_currency_code: string;
    total: string;
  }>(
    getDb(),
    sql`SELECT b.id, b.status, b.scheduled_at, b.scheduled_timezone,
               s.name AS service_name,
               ${mode === 'customer' ? sql`pp.business_name` : sql`NULL::text`} AS counterparty_name,
               b.price_amount_minor_units, b.price_currency_code,
               COUNT(*) OVER () AS total
          FROM bookings b
          JOIN services s ON s.id = b.service_id
          JOIN customer_profiles cp ON cp.id = b.customer_profile_id
          JOIN provider_profiles pp ON pp.id = b.provider_profile_id
         WHERE ${ownership}${statusFilter}
         ORDER BY b.scheduled_at DESC, b.id DESC
         LIMIT ${options.limit} OFFSET ${options.offset}`,
  );

  return {
    total: rows.length > 0 ? Number(rows[0]!.total) : 0,
    data: rows.map((row) => ({
      id: row.id,
      status: row.status,
      scheduledAt: new Date(row.scheduled_at).toISOString(),
      scheduledTimezone: row.scheduled_timezone,
      serviceName: row.service_name,
      counterpartyName: row.counterparty_name,
      priceAmountMinorUnits: row.price_amount_minor_units,
      currencyCode: row.price_currency_code,
    })),
  };
}
