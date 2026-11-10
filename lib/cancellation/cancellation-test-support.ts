/**
 * Spec 023 §6 fixtures.
 *
 * Built on spec 022's refund fixtures, which are built on spec 021's payment fixtures, which run the
 * REAL spec 015→020 path. Nothing here fakes a captured payment, a policy or a booking state: a
 * cancellable booking is one that genuinely went through authorization and capture, and the policy
 * these suites resolve against is the one migration `0019` actually seeds.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { registerBookingTransitions, resetRegisteredBookingTransitions } from '@/lib/bookings';
import { registerPaymentTransitions } from '@/lib/payments/state-machine';
import { registerRefundEligibilityGate, resetRefundEligibilityGate } from '@/lib/refunds/eligibility';
import type { CancellationPolicyConfig } from '@/lib/types/cancellation';
import type { NoShowLocationSignal, NoShowOutcome, NoShowStatus } from '@/lib/types/no-show';
import { cancellationRefundEligibility } from './refund-eligibility';
import { resetCancellationNotificationSink } from './notifications';
import { resetNoShowCommunicationsEvidence } from '@/lib/no-show/evidence';
import { resetNoShowReliabilitySink } from '@/lib/no-show/reliability';

import { useRefundIntegration as useRefundIntegrationFixtures } from '@/lib/refunds/refunds-test-support';

export {
  bookingStatusOf,
  completeBookingFor,
  freshKey,
  isDatabaseReachable,
  paymentStatusOf,
  seedCapturedBooking,
  seedStranger,
  storedRefunds,
  useRefundIntegration,
  resetRefundIntegration,
} from '@/lib/refunds/refunds-test-support';

/**
 * Registers spec 023's seams on top of spec 022's.
 *
 * Vitest gives each test file its own module registry, so the transitions `lib/cancellation/index.ts`
 * registers at import have to be re-registered per file — and AFTER spec 021/022's resets, which
 * clear them.
 */
export function useCancellationIntegration(): void {
  useRefundIntegrationFixtures();

  registerPaymentTransitions('spec 022 (refunds)', [
    ['captured', 'refunded'],
    ['captured', 'partially_refunded'],
    ['partially_refunded', 'refunded'],
  ]);
  registerBookingTransitions('spec 022 (refunds)', [
    ['completed', 'refunded'],
    ['protected', 'refunded'],
    ['settled', 'refunded'],
    ['cancelled', 'refunded'],
  ]);
  registerBookingTransitions('spec 023 (cancellation)', [
    ['confirmed', 'cancelled'],
    ['provider_en_route', 'cancelled'],
    ['arrived', 'cancelled'],
  ]);

  // The REAL gate — these suites prove the spec 022 handoff, so they must not stub it.
  registerRefundEligibilityGate(cancellationRefundEligibility);
  resetCancellationNotificationSink();
  resetNoShowCommunicationsEvidence();
  resetNoShowReliabilitySink();
}

export function resetCancellationIntegration(): void {
  resetRegisteredBookingTransitions();
  resetRefundEligibilityGate();
  resetCancellationNotificationSink();
  resetNoShowCommunicationsEvidence();
  resetNoShowReliabilitySink();
}

/**
 * Moves a booking's `scheduled_at` so a chosen number of hours remains before it.
 *
 * WHY THIS DISABLES A TRIGGER, briefly. The server always reads the DATABASE clock, so the only
 * honest way to exercise a tier is to change where the booking sits relative to now — and spec 020's
 * `bookings_terms_immutable_trg` (correctly) forbids changing `scheduled_at`, because a booking's
 * terms must never be rewritten by application code. That trigger guards against a code path doing
 * this; it is not a statement that time cannot pass. Production reaches "twelve hours before the
 * appointment" by waiting, which a test suite cannot do.
 *
 * So the trigger is disabled for exactly one statement, inside one transaction (`ALTER TABLE` is
 * transactional in Postgres, so it cannot leak if the test fails), and re-enabled immediately. This
 * is the same category of fixture as spec 021's `backdateProtectionWindow`, which backdates a column
 * directly for the same reason.
 *
 * Fractional values are supported deliberately: exactly 24h, exactly 12h and a hair either side are
 * the cases that matter most (AC-2/AC-3).
 */
export async function setHoursBeforeScheduled(bookingId: string, hoursBefore: number): Promise<void> {
  const seconds = Math.round(hoursBefore * 3600);
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE bookings DISABLE TRIGGER bookings_terms_immutable_trg`);
    await tx.execute(
      sql`UPDATE bookings SET scheduled_at = clock_timestamp() + make_interval(secs => ${seconds})
           WHERE id = ${bookingId}`,
    );
    await tx.execute(sql`ALTER TABLE bookings ENABLE TRIGGER bookings_terms_immutable_trg`);
  });
}

/** Drives a booking from `confirmed` to another cancellable status through the real spec 020 path. */
export async function advanceTo(
  scenario: { provider: { userId: string } },
  bookingId: string,
  target: 'provider_en_route' | 'arrived',
): Promise<void> {
  const { advanceBooking } = await import('@/lib/bookings/lifecycle');
  const { requireOwnProviderProfile } = await import('@/lib/availability/owner');
  const profile = await requireOwnProviderProfile(scenario.provider.userId);
  if (target === 'arrived') {
    await advanceBooking(scenario.provider.userId, profile.id, bookingId, 'arrived');
    return;
  }
  await advanceBooking(scenario.provider.userId, profile.id, bookingId, 'provider_en_route');
}

/**
 * TEST-ONLY: re-points a booking at another provider profile.
 *
 * Production never does this — `bookings_terms_immutable_trg` exists precisely to stop it, and
 * nothing in the application has a code path that would try. It is needed here for one honest
 * reason: proving that REPEATED verified no-shows accumulate against the same provider (AC-6)
 * otherwise requires seeding two entire offer→booking→payment scenarios that happen to share a
 * provider, which the fixtures cannot express. Suspending the trigger for one statement is the
 * smaller and more legible compromise, and it is confined to this helper.
 */
export async function reassignBookingProvider(bookingId: string, providerProfileId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE bookings DISABLE TRIGGER bookings_terms_immutable_trg`);
    await tx.execute(
      sql`UPDATE bookings SET provider_profile_id = ${providerProfileId} WHERE id = ${bookingId}`,
    );
    await tx.execute(sql`ALTER TABLE bookings ENABLE TRIGGER bookings_terms_immutable_trg`);
  });
}

/** The service and category a booking hangs off, for seeding scope overrides. */
export async function bookingScope(bookingId: string): Promise<{ serviceId: string; categoryId: string }> {
  const [row] = await queryRows<{ service_id: string; category_id: string }>(
    getDb(),
    sql`SELECT b.service_id, s.category_id FROM bookings b JOIN services s ON s.id = b.service_id
         WHERE b.id = ${bookingId}`,
  );
  return { serviceId: row!.service_id, categoryId: row!.category_id };
}

/**
 * Publishes an override directly, the way an admin's publish would leave the database.
 *
 * `effectiveFrom` defaults to the epoch so it covers bookings created before the test ran — the
 * same reason `0019` seeds the platform default from the epoch.
 */
export async function seedPolicyOverride(options: {
  scope: 'platform' | 'category' | 'service';
  scopeId: string | null;
  config: CancellationPolicyConfig;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  isActive?: boolean;
}): Promise<{ policyId: string; versionId: string }> {
  const db = getDb();
  const [policy] = await queryRows<{ id: string }>(
    db,
    sql`INSERT INTO policies (type, scope, scope_id, is_active)
        VALUES ('cancellation', ${options.scope}, ${options.scopeId}, ${options.isActive ?? true})
        RETURNING id`,
  );
  const [version] = await queryRows<{ id: string }>(
    db,
    sql`INSERT INTO policy_versions (policy_id, config, effective_from, effective_to)
        VALUES (${policy!.id}, ${JSON.stringify(options.config)}::jsonb,
                ${options.effectiveFrom ?? new Date(0)}, ${options.effectiveTo ?? null})
        RETURNING id`,
  );
  return { policyId: policy!.id, versionId: version!.id };
}

/** A flat-rate ladder, for proving precedence without arithmetic getting in the way. */
export function flatConfig(feePercent: number, allowedOptions: CancellationPolicyConfig['allowedOptions'] = []): CancellationPolicyConfig {
  return {
    tiers: [{ minHoursBefore: null, maxHoursBefore: null, feePercent }],
    allowedOptions,
  };
}

export async function storedCancellation(bookingId: string) {
  const [row] = await queryRows<{
    id: string;
    policy_version_id: string;
    cancelled_by_role: string;
    tier_fee_percent: number;
    hours_before_milli: number;
    captured_amount_minor_units: number;
    fee_amount_minor_units: number;
    refund_amount_minor_units: number;
    decision_ref: string;
    no_show_report_id: string | null;
  }>(
    getDb(),
    sql`SELECT id, policy_version_id, cancelled_by_role, tier_fee_percent, hours_before_milli,
               captured_amount_minor_units, fee_amount_minor_units, refund_amount_minor_units,
               decision_ref, no_show_report_id
          FROM booking_cancellations WHERE booking_id = ${bookingId}`,
  );
  return row ?? null;
}

export async function storedAcceptance(bookingId: string) {
  const [row] = await queryRows<{
    policy_version_id: string;
    source: string;
    provider_option_key: string | null;
    accepted_config: { tiers: Array<{ feePercent: number }> };
    booking_created_at: Date;
  }>(
    getDb(),
    sql`SELECT policy_version_id, source, provider_option_key, accepted_config, booking_created_at
          FROM policy_acceptances WHERE booking_id = ${bookingId}`,
  );
  return row ?? null;
}

export async function storedReports(bookingId: string) {
  return queryRows<{
    id: string;
    reporter_role: 'customer' | 'provider';
    status: NoShowStatus;
    outcome: NoShowOutcome | null;
    response_status: 'pending' | 'filed' | 'no_response';
    location_signal: NoShowLocationSignal;
    evidence: Record<string, unknown>;
    reporter_statement: string | null;
    response_statement: string | null;
    resolution_reason: string | null;
    resolved_by_admin_id: string | null;
    counterpart_report_id: string | null;
    respond_by_at: Date;
  }>(
    getDb(),
    sql`SELECT id, reporter_role, status, outcome, response_status, location_signal, evidence,
               reporter_statement, response_statement, resolution_reason, resolved_by_admin_id,
               counterpart_report_id, respond_by_at
          FROM no_show_reports WHERE booking_id = ${bookingId} ORDER BY created_at`,
  );
}

export async function reportHistory(reportId: string) {
  return queryRows<{ from_status: string | null; to_status: string; actor_role: string; detail: string | null }>(
    getDb(),
    sql`SELECT from_status, to_status, actor_role, detail FROM no_show_reports_status_history
         WHERE no_show_report_id = ${reportId} ORDER BY occurred_at`,
  );
}

/** Forces a report's response window into the past, so the sweep has something to find. */
export async function expireResponseWindow(reportId: string): Promise<void> {
  await getDb().execute(
    sql`UPDATE no_show_reports SET respond_by_at = clock_timestamp() - make_interval(hours => 1)
         WHERE id = ${reportId}`,
  );
}

/** Backdates a resolution so the retention sweep treats it as old enough to minimise. */
export async function backdateResolution(reportId: string, days: number): Promise<void> {
  await getDb().execute(
    sql`UPDATE no_show_reports SET resolved_at = clock_timestamp() - make_interval(days => ${days})
         WHERE id = ${reportId}`,
  );
}

/**
 * Opens the no-show reporting window by putting the booking's scheduled time in the past — the same
 * simulated passage of time, and the same one-statement trigger suspension, as
 * `setHoursBeforeScheduled`.
 */
export async function makeReportable(bookingId: string, minutesAgo = 60): Promise<void> {
  await setHoursBeforeScheduled(bookingId, -minutesAgo / 60);
}

export function uniqueKey(prefix = 'key'): string {
  return `${prefix}-${randomUUID()}`;
}
