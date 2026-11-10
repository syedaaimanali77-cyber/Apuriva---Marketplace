/**
 * Spec 045 §3.3 "How rows are produced" — the low-level, transaction-scoped writers the provisioner uses.
 *
 * Every function takes the caller's transaction: a whole demo set is ONE transaction (§3.2, §5 "never
 * partially reset"). The owning modules' public write functions (createRequest, createOffer, acceptOffer,
 * createBooking, …) each open their own top-level transaction, and several refuse a back-dated state by
 * design (an offer's two-minute window, a booking's early-start grace), so they cannot be composed into one.
 * The provisioner therefore uses the owning modules' TRANSACTION-COMPOSABLE primitives wherever one exists
 * (spec 021's `record.ts`, spec 022's refund state machine, spec 023's policy snapshot and fee computation,
 * spec 029's eligibility and signals, spec 026's renderer) and writes the rest here, mirroring each
 * module's own SQL.
 *
 * States that need elapsed time are reached exactly as §3.3 prescribes: by WALKING only transitions the
 * spec 003 `*_status_transition_trg` triggers accept — each step is a real `UPDATE … SET status`, which the
 * trigger checks against the seeded `*_status_transitions` table — with back-dated timestamps. No state is
 * inserted directly that the real state machine could not have produced, and every history row is written,
 * as the owning modules write it.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { queryRows, type Executor } from '@/lib/offers/db';
import { OFFER_WINDOW_MS } from '@/lib/offers/timer';
import { demoDisplayName, demoEmail } from '../identity';

export type ActorRole = 'customer' | 'provider' | 'system';

export interface DemoPerson {
  userId: string;
  customerProfileId: string;
  providerProfileId: string | null;
  displayName: string;
}

const iso = (date: Date) => date.toISOString();

// ---------------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------------

/**
 * A synthetic user of one set: `users` (is_demo, demo_set_id, undeliverable email), a `customer_profiles`
 * row with the "(Demo)" display name (spec 006 gives every account one), and — for a provider — an active
 * `provider_profiles` row whose business name also carries the suffix.
 */
export async function insertDemoPerson(
  tx: Executor,
  input: { setId: string; name: string; businessName?: string; createdAt: Date; userId?: string },
): Promise<DemoPerson> {
  const userId = input.userId ?? randomUUID();
  await tx.execute(sql`
    INSERT INTO users (id, email, is_demo, demo_set_id, created_at, updated_at)
    VALUES (${userId}, ${demoEmail(userId)}, true, ${input.setId}, ${iso(input.createdAt)}, ${iso(input.createdAt)})
  `);

  const displayName = demoDisplayName(input.name);
  const [customer] = await queryRows<{ id: string }>(
    tx,
    sql`INSERT INTO customer_profiles (user_id, display_name, created_at, updated_at)
        VALUES (${userId}, ${displayName}, ${iso(input.createdAt)}, ${iso(input.createdAt)})
        RETURNING id`,
  );

  let providerProfileId: string | null = null;
  if (input.businessName) {
    const [provider] = await queryRows<{ id: string }>(
      tx,
      sql`INSERT INTO provider_profiles (user_id, business_name, lifecycle_status, scheduling_timezone, created_at, updated_at)
          VALUES (${userId}, ${demoDisplayName(input.businessName)}, 'active', ${DEMO_TIMEZONE},
                  ${iso(input.createdAt)}, ${iso(input.createdAt)})
          RETURNING id`,
    );
    providerProfileId = provider!.id;
  }

  return { userId, customerProfileId: customer!.id, providerProfileId, displayName };
}

/** The zone every demo provider schedules in — spec 016's documented default. */
export const DEMO_TIMEZONE = 'Asia/Karachi';

export interface DemoPlace {
  area: string;
  city: string;
  latitudeMicroDegrees: number;
  longitudeMicroDegrees: number;
}

/** Spec 012's free-text structured address plus its `locations` point, as `seedAddressAt` writes them. */
export async function insertAddress(tx: Executor, userId: string, place: DemoPlace, label = 'Home'): Promise<string> {
  const structured = { area: place.area, city: place.city, country: 'Pakistan' };
  const [location] = await queryRows<{ id: string }>(
    tx,
    sql`INSERT INTO locations (latitude_micro_degrees, longitude_micro_degrees, geo_hierarchy)
        VALUES (${place.latitudeMicroDegrees}, ${place.longitudeMicroDegrees}, ${JSON.stringify(structured)}::jsonb)
        RETURNING id`,
  );
  const [address] = await queryRows<{ id: string }>(
    tx,
    sql`INSERT INTO addresses (user_id, location_id, label, structured, is_default)
        VALUES (${userId}, ${location!.id}, ${label}, ${JSON.stringify(structured)}::jsonb, true)
        RETURNING id`,
  );
  return address!.id;
}

// ---------------------------------------------------------------------------------------------------
// Provider catalog and availability (specs 011, 016)
// ---------------------------------------------------------------------------------------------------

export async function insertProviderService(
  tx: Executor,
  input: { providerProfileId: string; serviceId: string; durationMinutes: number },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO provider_services (provider_profile_id, service_id, duration_minutes)
    VALUES (${input.providerProfileId}, ${input.serviceId}, ${input.durationMinutes})
  `);
}

export async function insertPackage(
  tx: Executor,
  input: {
    providerProfileId: string;
    serviceId: string;
    name: string;
    description: string;
    amountMinorUnits: number;
    currencyCode: string;
    includedItems: string[];
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO service_packages (service_id, provider_profile_id, name, description, amount_minor_units, currency_code, included_items)
    VALUES (${input.serviceId}, ${input.providerProfileId}, ${input.name}, ${input.description},
            ${input.amountMinorUnits}, ${input.currencyCode}, ${JSON.stringify(input.includedItems)}::jsonb)
  `);
}

/** One window per weekday, `startMinute`–`endMinute` local (spec 016 R1/R6). */
export async function insertWeeklyHours(
  tx: Executor,
  providerProfileId: string,
  window: { startMinute: number; endMinute: number },
): Promise<void> {
  for (let day = 0; day < 7; day += 1) {
    await tx.execute(sql`
      INSERT INTO provider_availabilities (provider_profile_id, day_of_week, start_minute, end_minute)
      VALUES (${providerProfileId}, ${day}, ${window.startMinute}, ${window.endMinute})
    `);
  }
}

/** Spec 016 R3–R4: a date override that wholly replaces the weekly pattern for that local date. */
export async function insertOverride(
  tx: Executor,
  input: { providerProfileId: string; date: string; window: { startMinute: number; endMinute: number } | null },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO provider_availability_overrides (provider_profile_id, date, is_available, start_minute, end_minute)
    VALUES (${input.providerProfileId}, ${input.date}, ${input.window !== null},
            ${input.window?.startMinute ?? null}, ${input.window?.endMinute ?? null})
  `);
}

// ---------------------------------------------------------------------------------------------------
// Requests (spec 015) and matching (spec 017)
// ---------------------------------------------------------------------------------------------------

export interface DemoRequestInput {
  setId: string;
  customer: DemoPerson;
  serviceId: string;
  addressId: string;
  detailsFieldId: string;
  description: string;
  details: string;
  budget: { amountMinorUnits: number; currencyCode: string } | null;
  preferredAt: Date | null;
  createdAt: Date;
}

/**
 * Spec 015's create, as one transaction would write it: `draft`, the field values, then `draft → submitted`
 * through the trigger, with both history rows.
 */
export async function insertSubmittedRequest(tx: Executor, input: DemoRequestInput): Promise<string> {
  const body = {
    serviceId: input.serviceId,
    description: input.description,
    addressId: input.addressId,
    budget: input.budget,
    preferredAt: input.preferredAt ? iso(input.preferredAt) : null,
  };
  const [row] = await queryRows<{ id: string }>(
    tx,
    sql`INSERT INTO requests (
          customer_profile_id, service_id, status, description,
          budget_min_amount_minor_units, budget_min_currency_code, budget_max_amount_minor_units, budget_max_currency_code,
          preferred_at, preferred_timezone, address_id, urgency, idempotency_key, idempotency_fingerprint,
          created_at, updated_at
        ) VALUES (
          ${input.customer.customerProfileId}, ${input.serviceId}, 'draft', ${input.description},
          ${input.budget?.amountMinorUnits ?? null}, ${input.budget?.currencyCode ?? null},
          ${input.budget?.amountMinorUnits ?? null}, ${input.budget?.currencyCode ?? null},
          ${input.preferredAt ? iso(input.preferredAt) : null}, ${input.preferredAt ? DEMO_TIMEZONE : null},
          ${input.addressId}, 'normal', ${`demo:${input.setId}:${randomUUID()}`}, ${idempotencyFingerprint(body)},
          ${iso(input.createdAt)}, ${iso(input.createdAt)}
        ) RETURNING id`,
  );
  const requestId = row!.id;

  await tx.execute(sql`
    INSERT INTO request_field_values (request_id, service_field_id, value)
    VALUES (${requestId}, ${input.detailsFieldId}, ${JSON.stringify(input.details)}::jsonb)
  `);
  await tx.execute(sql`
    INSERT INTO requests_status_history (request_id, from_status, to_status, actor_user_id, occurred_at)
    VALUES (${requestId}, NULL, 'draft', ${input.customer.userId}, ${iso(input.createdAt)})
  `);
  await walkStatus(tx, 'requests', requestId, 'draft', [
    { to: 'submitted', at: input.createdAt, actorUserId: input.customer.userId },
  ]);
  return requestId;
}

/** Spec 017's distribution record: an eligible, ranked, notified match. */
export async function insertMatch(
  tx: Executor,
  input: { requestId: string; providerProfileId: string; rank: number; notifiedAt: Date; offerSentAt: Date | null },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO request_provider_matches (
      request_id, provider_profile_id, eligible, rank, score_micros, notified_at, provider_response, responded_at
    ) VALUES (
      ${input.requestId}, ${input.providerProfileId}, true, ${input.rank}, ${Math.max(0, 900_000 - input.rank * 50_000)},
      ${iso(input.notifiedAt)}, ${input.offerSentAt ? 'offer_sent' : 'none'},
      ${input.offerSentAt ? iso(input.offerSentAt) : null}
    )
  `);
}

// ---------------------------------------------------------------------------------------------------
// Offers (specs 018/019)
// ---------------------------------------------------------------------------------------------------

export interface DemoOfferInput {
  setId: string;
  requestId: string;
  provider: DemoPerson;
  priceAmountMinorUnits: number;
  currencyCode: string;
  includedItems: string[];
  providerMessage: string;
  estimatedDurationMinutes: number;
  sentAt: Date;
}

/**
 * `insertSentOffer`'s two statements with a back-dated send instant: `draft`, then `draft → sent` through the
 * trigger with `expires_at = sent_at + 2 minutes` (the `offers_two_minute_window_ck` invariant), plus both
 * history rows.
 */
export async function insertSentOffer(tx: Executor, input: DemoOfferInput): Promise<string> {
  const terms = {
    priceAmountMinorUnits: input.priceAmountMinorUnits,
    currencyCode: input.currencyCode,
    includedItems: input.includedItems,
    providerMessage: input.providerMessage,
    estimatedDurationMinutes: input.estimatedDurationMinutes,
  };
  const [row] = await queryRows<{ id: string }>(
    tx,
    sql`INSERT INTO offers (
          request_id, provider_profile_id, status, price_amount_minor_units, price_currency_code, included_items,
          provider_message, estimated_duration_minutes, idempotency_key, idempotency_fingerprint, created_at, updated_at
        ) VALUES (
          ${input.requestId}, ${input.provider.providerProfileId}, 'draft', ${input.priceAmountMinorUnits}, ${input.currencyCode},
          ${JSON.stringify(input.includedItems)}::jsonb, ${input.providerMessage}, ${input.estimatedDurationMinutes},
          ${`demo:${input.setId}:${randomUUID()}`}, ${idempotencyFingerprint({ requestId: input.requestId, ...terms })},
          ${iso(input.sentAt)}, ${iso(input.sentAt)}
        ) RETURNING id`,
  );
  const offerId = row!.id;
  const expiresAt = new Date(input.sentAt.getTime() + OFFER_WINDOW_MS);

  await tx.execute(sql`
    INSERT INTO offers_status_history (offer_id, from_status, to_status, actor_user_id, occurred_at)
    VALUES (${offerId}, NULL, 'draft', ${input.provider.userId}, ${iso(input.sentAt)})
  `);
  await walkStatus(tx, 'offers', offerId, 'draft', [
    {
      to: 'sent',
      at: input.sentAt,
      actorUserId: input.provider.userId,
      set: sql`, sent_at = ${iso(input.sentAt)}::timestamptz, expires_at = ${iso(expiresAt)}::timestamptz`,
    },
  ]);
  return offerId;
}

/** The extra columns spec 018 writes with each offer decision. */
export function offerDecisionColumns(to: 'viewed' | 'accepted' | 'declined' | 'withdrawn' | 'expired', at: Date) {
  if (to === 'viewed') return sql`, viewed_at = ${iso(at)}::timestamptz`;
  if (to === 'accepted') return sql`, decided_at = ${iso(at)}::timestamptz, accept_idempotency_key = ${randomUUID()}`;
  if (to === 'declined' || to === 'withdrawn') return sql`, decided_at = ${iso(at)}::timestamptz`;
  return sql``;
}

// ---------------------------------------------------------------------------------------------------
// Bookings (spec 020)
// ---------------------------------------------------------------------------------------------------

/**
 * Spec 020 step 14: the booking row, its price copied VERBATIM from the accepted offer row (never passed in),
 * plus the `(null → pending)` history row `recordBookingCreated` writes.
 */
export async function insertPendingBooking(
  tx: Executor,
  input: {
    setId: string;
    offerId: string;
    requestId: string;
    serviceId: string;
    customer: DemoPerson;
    providerProfileId: string;
    addressId: string;
    scheduledAt: Date;
    durationMinutes: number;
    createdAt: Date;
  },
): Promise<{ id: string; priceAmountMinorUnits: number; currencyCode: string }> {
  const key = `demo:${input.setId}:${randomUUID()}`;
  const [row] = await queryRows<{ id: string; price_amount_minor_units: number; price_currency_code: string }>(
    tx,
    sql`INSERT INTO bookings (
          offer_id, status, request_id, service_id, customer_profile_id, provider_profile_id, address_id,
          scheduled_at, scheduled_timezone, duration_minutes, price_amount_minor_units, price_currency_code,
          idempotency_key, idempotency_fingerprint, created_at, updated_at
        )
        SELECT o.id, 'pending', ${input.requestId}, ${input.serviceId}, ${input.customer.customerProfileId},
               ${input.providerProfileId}, ${input.addressId}, ${iso(input.scheduledAt)}::timestamptz, ${DEMO_TIMEZONE},
               ${input.durationMinutes}, o.price_amount_minor_units, o.price_currency_code,
               ${key}, ${idempotencyFingerprint({ offerId: input.offerId, scheduledAt: iso(input.scheduledAt) })},
               ${iso(input.createdAt)}::timestamptz, ${iso(input.createdAt)}::timestamptz
          FROM offers o WHERE o.id = ${input.offerId}
        RETURNING id, price_amount_minor_units, price_currency_code`,
  );
  await tx.execute(sql`
    INSERT INTO bookings_status_history (booking_id, from_status, to_status, actor_user_id, actor_role, occurred_at)
    VALUES (${row!.id}, NULL, 'pending', ${input.customer.userId}, 'customer', ${iso(input.createdAt)})
  `);
  return { id: row!.id, priceAmountMinorUnits: row!.price_amount_minor_units, currencyCode: row!.price_currency_code };
}

// ---------------------------------------------------------------------------------------------------
// The trigger walk
// ---------------------------------------------------------------------------------------------------

export interface WalkStep {
  to: string;
  at: Date;
  actorUserId: string | null;
  /** Bookings only: spec 020's actor vocabulary (`bookings_status_history.actor_role`). */
  actorRole?: ActorRole;
  /** Extra column assignments applied in the same UPDATE (e.g. an offer's `decided_at`). */
  set?: ReturnType<typeof sql>;
}

type WalkedTable = 'requests' | 'offers' | 'bookings';

/**
 * Applies each step as a real status UPDATE — the spec 003 trigger rejects any pair its transitions table
 * does not hold, so an impossible state cannot be written — and appends the matching history row with the
 * step's (back-dated) instant. Conditional on the expected current status, like every owning module's
 * transition primitive; a mismatch is a programming error and aborts the whole set.
 */
export async function walkStatus(tx: Executor, table: WalkedTable, id: string, from: string, steps: WalkStep[]): Promise<string> {
  let current = from;
  for (const step of steps) {
    const extra = step.set ?? sql``;
    const updated = await queryRows<{ id: string }>(
      tx,
      sql`UPDATE ${sql.raw(table)}
             SET status = ${step.to}, updated_at = ${iso(step.at)}::timestamptz, version = version + 1 ${extra}
           WHERE id = ${id} AND status = ${current}
           RETURNING id`,
    );
    if (updated.length === 0) throw new Error(`demo seed: ${table} ${id} is not in status ${current}`);

    if (table === 'bookings') {
      const role = step.actorRole ?? 'system';
      await tx.execute(sql`
        INSERT INTO bookings_status_history (booking_id, from_status, to_status, actor_user_id, actor_role, occurred_at)
        VALUES (${id}, ${current}, ${step.to}, ${role === 'system' ? null : step.actorUserId}, ${role}, ${iso(step.at)})
      `);
    } else {
      const historyTable = table === 'requests' ? 'requests_status_history' : 'offers_status_history';
      const fk = table === 'requests' ? 'request_id' : 'offer_id';
      await tx.execute(sql`
        INSERT INTO ${sql.raw(historyTable)} (${sql.raw(fk)}, from_status, to_status, actor_user_id, occurred_at)
        VALUES (${id}, ${current}, ${step.to}, ${step.actorUserId}, ${iso(step.at)})
      `);
    }
    current = step.to;
  }
  return current;
}
