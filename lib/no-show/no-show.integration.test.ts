import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { grantRole, registerAdmin, type TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import type { ApiRouteError } from '@/lib/api/errors';
import {
  backdateResolution,
  bookingStatusOf,
  expireResponseWindow,
  isDatabaseReachable,
  makeReportable,
  reassignBookingProvider,
  reportHistory,
  resetCancellationIntegration,
  seedCapturedBooking,
  seedStranger,
  storedCancellation,
  storedRefunds,
  storedReports,
  uniqueKey,
  useCancellationIntegration,
} from '@/lib/cancellation/cancellation-test-support';
import { listReportsForBooking, reportNoShow, respondToNoShow, withdrawNoShow } from './report';
import { listNoShowReportsForAdmin, readNoShowReportForAdmin, resolveNoShowReport } from './resolution';
import { countVerifiedNoShows, registerNoShowReliabilitySink, type VerifiedNoShowSignal } from './reliability';
import { runNoShowResponseSweep } from './sweep';
import { sweepNoShowEvidence } from './retention';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 90_000;

afterAll(async () => {
  await getPool().end();
});

async function expectError(fn: () => Promise<unknown>, code: string): Promise<ApiRouteError> {
  try {
    await fn();
  } catch (err) {
    expect((err as ApiRouteError).code).toBe(code);
    return err as ApiRouteError;
  }
  throw new Error(`expected ${code} to be thrown`);
}

/** A Trust & Safety admin. The `no_show_reports/*` permissions come from migration 0019's own seed. */
async function trustSafetyAdmin(): Promise<TestAdmin> {
  resetRateLimitState();
  const admin = await registerAdmin();
  await grantRole(admin, 'trust_safety_admin');
  resetRateLimitState();
  return admin;
}

/** A booking past its scheduled time, so a no-show is a coherent claim. */
async function seedReportableBooking() {
  const seeded = await seedCapturedBooking();
  await makeReportable(seeded.bookingId, 60);
  return seeded;
}

describe.skipIf(!dbReachable)('spec 023 no-show', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    useCancellationIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetCancellationIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  describe('reporting (AC-5)', () => {
    /** The load-bearing property: a report changes NOTHING except that a review has been asked for. */
    it('creates a report awaiting the other party, with no consequence of any kind', async () => {
      const { scenario, bookingId } = await seedReportableBooking();

      const report = await reportNoShow({
        userId: scenario.customer.userId,
        bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
        statement: 'Nobody arrived.',
      });

      expect(report.status).toBe('awaiting_response');
      expect(report.outcome).toBeNull();
      expect(report.responseFiled).toBe(false);

      // Nothing moved: no booking transition, no cancellation record, no refund.
      expect(await bookingStatusOf(bookingId)).toBe('confirmed');
      expect(await storedCancellation(bookingId)).toBeNull();
      expect(await storedRefunds(bookingId)).toHaveLength(0);
    });

    it('records both the reported and awaiting_response steps in history', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      const report = await reportNoShow({
        userId: scenario.customer.userId,
        bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });

      const history = await reportHistory(report.id);
      expect(history.map((h) => h.to_status)).toEqual(['reported', 'awaiting_response']);
      expect(history[0]!.actor_role).toBe('customer');
    });

    it('gathers evidence made only of derived facts — and never a coordinate', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      const admin = await trustSafetyAdmin();
      await reportNoShow({ userId: scenario.customer.userId, bookingId, mode: 'customer', idempotencyKey: uniqueKey() });

      const [stored] = await storedReports(bookingId);
      const evidence = stored!.evidence as Record<string, unknown>;

      expect(evidence).toHaveProperty('scheduledAt');
      expect(evidence).toHaveProperty('statusHistory');
      expect(evidence).toHaveProperty('communications');
      // Spec 025 has not shipped: the port reports absence rather than inventing messages.
      expect((evidence.communications as { available: boolean }).available).toBe(false);

      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toMatch(/latitude|longitude|coordinates|gps/i);

      const adminView = await readNoShowReportForAdmin(stored!.id);
      expect(JSON.stringify(adminView)).not.toMatch(/latitude|longitude/i);
      void admin;
    });

    it('rejects a duplicate report by the same party', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      await reportNoShow({ userId: scenario.customer.userId, bookingId, mode: 'customer', idempotencyKey: uniqueKey() });

      await expectError(
        () =>
          reportNoShow({ userId: scenario.customer.userId, bookingId, mode: 'customer', idempotencyKey: uniqueKey() }),
        'NO_SHOW_REPORT_ALREADY_EXISTS',
      );
      expect(await storedReports(bookingId)).toHaveLength(1);
    });

    it('replays an identical retry rather than creating a second report', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      const key = uniqueKey();
      const first = await reportNoShow({ userId: scenario.customer.userId, bookingId, mode: 'customer', idempotencyKey: key });
      const second = await reportNoShow({ userId: scenario.customer.userId, bookingId, mode: 'customer', idempotencyKey: key });

      expect(second.id).toBe(first.id);
      expect(await storedReports(bookingId)).toHaveLength(1);
    });

    /** Explicitly permitted: two rows, opposite roles, linked so an admin reviews them together. */
    it('lets both parties report each other, and links the pair', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      await reportNoShow({ userId: scenario.customer.userId, bookingId, mode: 'customer', idempotencyKey: uniqueKey() });
      await reportNoShow({ userId: scenario.provider.userId, bookingId, mode: 'provider', idempotencyKey: uniqueKey() });

      const reports = await storedReports(bookingId);
      expect(reports).toHaveLength(2);
      expect(reports.map((r) => r.reporter_role).sort()).toEqual(['customer', 'provider']);
      expect(reports[0]!.counterpart_report_id).toBe(reports[1]!.id);
      expect(reports[1]!.counterpart_report_id).toBe(reports[0]!.id);
    });

    it('refuses a report before the window opens or after it closes', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      // Still in the future: nobody can be absent yet.
      const tooEarly = await expectError(
        () => reportNoShow({ userId: scenario.customer.userId, bookingId, mode: 'customer', idempotencyKey: uniqueKey() }),
        'NO_SHOW_REPORT_WINDOW_CLOSED',
      );
      expect(tooEarly.status).toBe(422);

      await makeReportable(bookingId, 80 * 60); // 80 hours ago, past the 72-hour close.
      await expectError(
        () => reportNoShow({ userId: scenario.customer.userId, bookingId, mode: 'customer', idempotencyKey: uniqueKey() }),
        'NO_SHOW_REPORT_WINDOW_CLOSED',
      );
    });

    it('a stranger cannot report on someone else’s booking', async () => {
      const { bookingId } = await seedReportableBooking();
      const stranger = await seedStranger();

      await expectError(
        () =>
          reportNoShow({ userId: stranger.customer.userId, bookingId, mode: 'customer', idempotencyKey: uniqueKey() }),
        'BOOKING_NOT_FOUND',
      );
    });
  });

  describe('response (AC-5)', () => {
    it('the other party’s response moves the report to under_review', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      const report = await reportNoShow({
        userId: scenario.customer.userId,
        bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });

      const responded = await respondToNoShow({
        userId: scenario.provider.userId,
        reportId: report.id,
        statement: 'I was there and waited.',
      });

      expect(responded.status).toBe('under_review');
      expect(responded.responseFiled).toBe(true);
      // Still no consequence: only an admin can produce one.
      expect(await bookingStatusOf(bookingId)).toBe('confirmed');
    });

    /** The reporter sees their own report, so hiding it would mislead: `403`, not `404`. */
    it('the reporter cannot respond to their own report', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      const report = await reportNoShow({
        userId: scenario.customer.userId,
        bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });

      const error = await expectError(
        () => respondToNoShow({ userId: scenario.customer.userId, reportId: report.id }),
        'NO_SHOW_SELF_ACTION_NOT_ALLOWED',
      );
      expect(error.status).toBe(403);
    });

    it('a stranger gets NO_SHOW_REPORT_NOT_FOUND, never a 403', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      const report = await reportNoShow({
        userId: scenario.customer.userId,
        bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });
      const stranger = await seedStranger();

      const error = await expectError(
        () => respondToNoShow({ userId: stranger.customer.userId, reportId: report.id }),
        'BOOKING_NOT_FOUND',
      );
      expect(error.status).toBe(404);
    });

    it('refuses a second response', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      const report = await reportNoShow({
        userId: scenario.customer.userId,
        bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });
      await respondToNoShow({ userId: scenario.provider.userId, reportId: report.id });

      await expectError(
        () => respondToNoShow({ userId: scenario.provider.userId, reportId: report.id }),
        'NO_SHOW_RESPONSE_ALREADY_FILED',
      );
    });

    it('the reporter may withdraw while awaiting a response, but not after review begins', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      const report = await reportNoShow({
        userId: scenario.customer.userId,
        bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });

      const withdrawn = await withdrawNoShow(scenario.customer.userId, report.id);
      expect(withdrawn.status).toBe('withdrawn');

      await expectError(() => withdrawNoShow(scenario.customer.userId, report.id), 'NO_SHOW_REPORT_ALREADY_RESOLVED');
    });
  });

  describe('the response-timeout sweep (AC-5)', () => {
    /**
     * SILENCE IS NOT AN ADMISSION. The sweep moves the report into review and records that nobody
     * answered — it sets no outcome, blames nobody and touches neither the booking nor any money.
     */
    it('moves an unanswered report to under_review with no consequence at all', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      const report = await reportNoShow({
        userId: scenario.customer.userId,
        bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });
      await expireResponseWindow(report.id);

      const result = await runNoShowResponseSweep();
      expect(result.movedToReview).toBeGreaterThanOrEqual(1);

      const [stored] = await storedReports(bookingId);
      expect(stored!.status).toBe('under_review');
      expect(stored!.response_status).toBe('no_response');
      expect(stored!.outcome).toBeNull();
      expect(await bookingStatusOf(bookingId)).toBe('confirmed');
      expect(await storedRefunds(bookingId)).toHaveLength(0);

      const history = await reportHistory(report.id);
      expect(history.at(-1)!.actor_role).toBe('system');
      expect(history.at(-1)!.detail).toBe('response_window_elapsed');
    });

    it('leaves a report whose window has not elapsed alone', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      await reportNoShow({ userId: scenario.customer.userId, bookingId, mode: 'customer', idempotencyKey: uniqueKey() });

      await runNoShowResponseSweep();

      const [stored] = await storedReports(bookingId);
      expect(stored!.status).toBe('awaiting_response');
      expect(stored!.response_status).toBe('pending');
    });

    it('is idempotent: a second pass changes nothing', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      const report = await reportNoShow({
        userId: scenario.customer.userId,
        bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });
      await expireResponseWindow(report.id);

      await runNoShowResponseSweep();
      const historyAfterFirst = await reportHistory(report.id);
      await runNoShowResponseSweep();

      expect(await reportHistory(report.id)).toHaveLength(historyAfterFirst.length);
    });
  });

  describe('Trust & Safety resolution (AC-9)', () => {
    async function reportUnderReview() {
      const seeded = await seedReportableBooking();
      const report = await reportNoShow({
        userId: seeded.scenario.customer.userId,
        bookingId: seeded.bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });
      await respondToNoShow({ userId: seeded.scenario.provider.userId, reportId: report.id });
      return { ...seeded, reportId: report.id };
    }

    it('refuses to resolve before the other party has been heard', async () => {
      const seeded = await seedReportableBooking();
      const report = await reportNoShow({
        userId: seeded.scenario.customer.userId,
        bookingId: seeded.bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });
      const admin = await trustSafetyAdmin();

      const error = await expectError(
        () =>
          resolveNoShowReport({
            adminUserId: admin.userId,
            reportId: report.id,
            outcome: 'no_show_confirmed_provider',
            reason: 'too early',
          }),
        'NO_SHOW_RESPONSE_REQUIRED',
      );
      expect(error.status).toBe(422);
      expect((await storedReports(seeded.bookingId))[0]!.outcome).toBeNull();
    });

    it('an admin without the permission is refused', async () => {
      const { reportId } = await reportUnderReview();
      resetRateLimitState();
      const wrongAdmin = await registerAdmin();
      await grantRole(wrongAdmin, 'content_admin');
      resetRateLimitState();

      await expectError(
        () =>
          resolveNoShowReport({
            adminUserId: wrongAdmin.userId,
            reportId,
            outcome: 'no_fault',
            reason: 'not mine to decide',
          }),
        'FORBIDDEN',
      );
    });

    it('requires a reason and a known outcome', async () => {
      const { reportId } = await reportUnderReview();
      const admin = await trustSafetyAdmin();

      await expectError(
        () => resolveNoShowReport({ adminUserId: admin.userId, reportId, outcome: 'no_fault', reason: '  ' }),
        'NO_SHOW_OUTCOME_INVALID',
      );
      await expectError(
        () =>
          resolveNoShowReport({
            adminUserId: admin.userId,
            reportId,
            outcome: 'whatever' as never,
            reason: 'because',
          }),
        'NO_SHOW_OUTCOME_INVALID',
      );
    });

    /** A confirmed CUSTOMER no-show: the provider is compensated, so no refund is due. */
    it('a confirmed customer no-show cancels the booking with no refund', async () => {
      const { bookingId, reportId } = await reportUnderReview();
      const admin = await trustSafetyAdmin();

      const resolved = await resolveNoShowReport({
        adminUserId: admin.userId,
        reportId,
        outcome: 'no_show_confirmed_customer',
        reason: 'Provider waited 30 minutes and messaged twice.',
      });

      expect(resolved.status).toBe('resolved');
      expect(resolved.outcome).toBe('no_show_confirmed_customer');
      expect(await bookingStatusOf(bookingId)).toBe('cancelled');

      const cancellation = await storedCancellation(bookingId);
      expect(cancellation!.cancelled_by_role).toBe('admin');
      expect(cancellation!.no_show_report_id).toBe(reportId);
      expect(cancellation!.refund_amount_minor_units).toBe(0);
      expect(await storedRefunds(bookingId)).toHaveLength(0);
    });

    /** A confirmed PROVIDER no-show: the customer never pays a timing fee for someone else's absence. */
    it('a confirmed provider no-show refunds the customer in full, regardless of tier', async () => {
      const { bookingId, reportId, capturedAmountMinorUnits } = await reportUnderReview();
      const admin = await trustSafetyAdmin();

      await resolveNoShowReport({
        adminUserId: admin.userId,
        reportId,
        outcome: 'no_show_confirmed_provider',
        reason: 'Provider never marked en route and did not respond.',
      });

      const cancellation = await storedCancellation(bookingId);
      expect(cancellation!.fee_amount_minor_units).toBe(0);
      expect(cancellation!.refund_amount_minor_units).toBe(capturedAmountMinorUnits);
      // The tier that WOULD have applied is still recorded, so the override is visible in the audit.
      expect(cancellation!.tier_fee_percent).toBe(100);

      const refunds = await storedRefunds(bookingId);
      expect(refunds).toHaveLength(1);
      expect(refunds[0]!.total_amount_minor_units).toBe(capturedAmountMinorUnits);
    });

    it('an inconclusive resolution changes nothing financial', async () => {
      const { bookingId, reportId } = await reportUnderReview();
      const admin = await trustSafetyAdmin();

      await resolveNoShowReport({
        adminUserId: admin.userId,
        reportId,
        outcome: 'inconclusive',
        reason: 'Accounts conflict and there is no other evidence.',
      });

      expect(await bookingStatusOf(bookingId)).toBe('confirmed');
      expect(await storedCancellation(bookingId)).toBeNull();
      expect(await storedRefunds(bookingId)).toHaveLength(0);
    });

    it('escalation closes the report here and creates no dispute of its own', async () => {
      const { bookingId, reportId } = await reportUnderReview();
      const admin = await trustSafetyAdmin();

      const resolved = await resolveNoShowReport({
        adminUserId: admin.userId,
        reportId,
        outcome: 'escalated_to_dispute',
        reason: 'Needs formal dispute resolution.',
      });

      expect(resolved.escalated).toBe(true);
      expect(await bookingStatusOf(bookingId)).toBe('confirmed');
    });

    it('refuses a second resolution', async () => {
      const { reportId } = await reportUnderReview();
      const admin = await trustSafetyAdmin();
      await resolveNoShowReport({ adminUserId: admin.userId, reportId, outcome: 'no_fault', reason: 'first' });

      await expectError(
        () => resolveNoShowReport({ adminUserId: admin.userId, reportId, outcome: 'no_fault', reason: 'second' }),
        'NO_SHOW_REPORT_ALREADY_RESOLVED',
      );
    });

    it('two concurrent resolutions admit exactly one', async () => {
      const { reportId } = await reportUnderReview();
      const admin = await trustSafetyAdmin();

      const results = await Promise.allSettled([
        resolveNoShowReport({ adminUserId: admin.userId, reportId, outcome: 'no_fault', reason: 'a' }),
        resolveNoShowReport({ adminUserId: admin.userId, reportId, outcome: 'inconclusive', reason: 'b' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('writes a spec 009 audit event naming the admin, outcome and reason', async () => {
      const { reportId } = await reportUnderReview();
      const admin = await trustSafetyAdmin();
      await resolveNoShowReport({
        adminUserId: admin.userId,
        reportId,
        outcome: 'no_fault',
        reason: 'Both parties agree there was a mix-up.',
      });

      const { sql } = await import('drizzle-orm');
      const result = (await getDb().execute(
        sql`SELECT event_type, metadata FROM security_events
             WHERE user_id = ${admin.userId} AND event_type = 'admin_rbac.no_show_resolved'`,
      )) as unknown as { rows: Array<{ event_type: string; metadata: Record<string, unknown> }> };

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]!.metadata.resource).toBe('no_show_reports');
      expect(result.rows[0]!.metadata.action).toBe('resolve');
      expect(result.rows[0]!.metadata.targetId).toBe(reportId);
      expect(result.rows[0]!.metadata.reason).toContain('mix-up');
    });

    /** AC-6 exactly-once, at the database: mutual reports cannot both carry fault. */
    it('refuses a second fault finding on the same booking', async () => {
      const seeded = await seedReportableBooking();
      const first = await reportNoShow({
        userId: seeded.scenario.customer.userId,
        bookingId: seeded.bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });
      const second = await reportNoShow({
        userId: seeded.scenario.provider.userId,
        bookingId: seeded.bookingId,
        mode: 'provider',
        idempotencyKey: uniqueKey(),
      });
      await respondToNoShow({ userId: seeded.scenario.provider.userId, reportId: first.id });
      await respondToNoShow({ userId: seeded.scenario.customer.userId, reportId: second.id });

      const admin = await trustSafetyAdmin();
      await resolveNoShowReport({
        adminUserId: admin.userId,
        reportId: first.id,
        outcome: 'no_show_confirmed_provider',
        reason: 'Provider did not attend.',
      });

      await expectError(
        () =>
          resolveNoShowReport({
            adminUserId: admin.userId,
            reportId: second.id,
            outcome: 'no_show_confirmed_customer',
            reason: 'contradictory',
          }),
        'NO_SHOW_FAULT_ALREADY_RECORDED',
      );
    });
  });

  describe('the reliability signal (AC-6)', () => {
    async function resolveWith(outcome: 'no_show_confirmed_customer' | 'no_show_confirmed_provider' | 'no_fault') {
      const seeded = await seedReportableBooking();
      const report = await reportNoShow({
        userId: seeded.scenario.customer.userId,
        bookingId: seeded.bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });
      await respondToNoShow({ userId: seeded.scenario.provider.userId, reportId: report.id });
      const admin = await trustSafetyAdmin();
      await resolveNoShowReport({ adminUserId: admin.userId, reportId: report.id, outcome, reason: 'reviewed' });
      return seeded;
    }

    it('counts a verified provider no-show against the provider', async () => {
      const seeded = await resolveWith('no_show_confirmed_provider');
      const { sql } = await import('drizzle-orm');
      const result = (await getDb().execute(
        sql`SELECT provider_profile_id, customer_profile_id FROM bookings WHERE id = ${seeded.bookingId}`,
      )) as unknown as { rows: Array<{ provider_profile_id: string; customer_profile_id: string }> };
      const { provider_profile_id, customer_profile_id } = result.rows[0]!;

      expect(
        await countVerifiedNoShows(getDb(), { subjectRole: 'provider', subjectProfileId: provider_profile_id }),
      ).toBe(1);
      // Never the reporter, and never the other party.
      expect(
        await countVerifiedNoShows(getDb(), { subjectRole: 'customer', subjectProfileId: customer_profile_id }),
      ).toBe(0);
    });

    it('counts nothing for a no_fault resolution', async () => {
      const seeded = await resolveWith('no_fault');
      const { sql } = await import('drizzle-orm');
      const result = (await getDb().execute(
        sql`SELECT provider_profile_id FROM bookings WHERE id = ${seeded.bookingId}`,
      )) as unknown as { rows: Array<{ provider_profile_id: string }> };

      expect(
        await countVerifiedNoShows(getDb(), {
          subjectRole: 'provider',
          subjectProfileId: result.rows[0]!.provider_profile_id,
        }),
      ).toBe(0);
    });

    it('emits the signal exactly once, attributed to the faulted party', async () => {
      const signals: VerifiedNoShowSignal[] = [];
      registerNoShowReliabilitySink(async (signal) => {
        signals.push(signal);
      });

      await resolveWith('no_show_confirmed_provider');

      expect(signals).toHaveLength(1);
      expect(signals[0]!.subjectRole).toBe('provider');
    });

    /** A sink failure must never undo a Trust & Safety decision that is already recorded. */
    it('a throwing sink does not fail the resolution', async () => {
      registerNoShowReliabilitySink(async () => {
        throw new Error('sink is down');
      });

      const seeded = await resolveWith('no_show_confirmed_provider');
      const [stored] = await storedReports(seeded.bookingId);
      expect(stored!.outcome).toBe('no_show_confirmed_provider');
    });

    it('repeated verified no-shows raise the count', async () => {
      const first = await resolveWith('no_show_confirmed_provider');
      const { sql } = await import('drizzle-orm');
      const result = (await getDb().execute(
        sql`SELECT provider_profile_id FROM bookings WHERE id = ${first.bookingId}`,
      )) as unknown as { rows: Array<{ provider_profile_id: string }> };
      const providerProfileId = result.rows[0]!.provider_profile_id;

      expect(await countVerifiedNoShows(getDb(), { subjectRole: 'provider', subjectProfileId: providerProfileId })).toBe(1);

      // A second verified no-show that ends up attributed to the SAME provider. The whole flow runs
      // against its own scenario — report, response and resolution are all real — and only then is
      // the booking re-pointed at the first provider (see `reassignBookingProvider`: seeding two
      // full scenarios that share a provider is not something the offer fixtures can express).
      // The count is a join against the booking, so it reflects the attribution as it now stands.
      const second = await seedReportableBooking();
      const report = await reportNoShow({
        userId: second.scenario.customer.userId,
        bookingId: second.bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
      });
      await respondToNoShow({ userId: second.scenario.provider.userId, reportId: report.id });
      const admin = await trustSafetyAdmin();
      await resolveNoShowReport({
        adminUserId: admin.userId,
        reportId: report.id,
        outcome: 'no_show_confirmed_provider',
        reason: 'again',
      });
      await reassignBookingProvider(second.bookingId, providerProfileId);

      expect(await countVerifiedNoShows(getDb(), { subjectRole: 'provider', subjectProfileId: providerProfileId })).toBe(2);
    });

    /** Master spec §132.11: a count is a signal, never an enforcement action. */
    it('never changes any account’s lifecycle status', async () => {
      const seeded = await resolveWith('no_show_confirmed_provider');
      const { sql } = await import('drizzle-orm');
      const result = (await getDb().execute(
        sql`SELECT u.lifecycle_status FROM bookings b
              JOIN provider_profiles pp ON pp.id = b.provider_profile_id
              JOIN users u ON u.id = pp.user_id
             WHERE b.id = ${seeded.bookingId}`,
      )) as unknown as { rows: Array<{ lifecycle_status: string }> };

      expect(result.rows[0]!.lifecycle_status).toBe('active');
    });
  });

  describe('privacy and retention (AC-10)', () => {
    async function resolvedReportWithStatements() {
      const seeded = await seedReportableBooking();
      const report = await reportNoShow({
        userId: seeded.scenario.customer.userId,
        bookingId: seeded.bookingId,
        mode: 'customer',
        idempotencyKey: uniqueKey(),
        statement: 'REPORTER SECRET',
      });
      await respondToNoShow({
        userId: seeded.scenario.provider.userId,
        reportId: report.id,
        statement: 'RESPONDER SECRET',
      });
      const admin = await trustSafetyAdmin();
      await resolveNoShowReport({
        adminUserId: admin.userId,
        reportId: report.id,
        outcome: 'no_fault',
        reason: 'ADMIN NOTE',
      });
      return { ...seeded, reportId: report.id };
    }

    it('shows a participant neither party’s statement, the evidence, nor any admin field', async () => {
      const { scenario, bookingId } = await resolvedReportWithStatements();

      for (const userId of [scenario.customer.userId, scenario.provider.userId]) {
        const reports = await listReportsForBooking(userId, bookingId);
        const serialized = JSON.stringify(reports);
        expect(serialized).not.toContain('REPORTER SECRET');
        expect(serialized).not.toContain('RESPONDER SECRET');
        expect(serialized).not.toContain('ADMIN NOTE');
        expect(serialized).not.toMatch(/locationSignal|evidence|resolvedByAdminId/);
      }
    });

    it('shows Trust & Safety the full bundle', async () => {
      const { reportId } = await resolvedReportWithStatements();
      const adminView = await readNoShowReportForAdmin(reportId);

      expect(adminView.reporterStatement).toBe('REPORTER SECRET');
      expect(adminView.responseStatement).toBe('RESPONDER SECRET');
      expect(adminView.resolutionReason).toBe('ADMIN NOTE');
      expect(adminView.locationSignal).toBeDefined();
    });

    it('marks whether a report is the caller’s own', async () => {
      const { scenario, bookingId } = await resolvedReportWithStatements();
      const asCustomer = await listReportsForBooking(scenario.customer.userId, bookingId);
      const asProvider = await listReportsForBooking(scenario.provider.userId, bookingId);

      expect(asCustomer[0]!.isOwnReport).toBe(true);
      expect(asProvider[0]!.isOwnReport).toBe(false);
    });

    /** Evidence is minimised on schedule; the audit skeleton is retained. */
    it('nulls evidence after the retention window but keeps the outcome and resolving admin', async () => {
      const { bookingId, reportId } = await resolvedReportWithStatements();
      await backdateResolution(reportId, 400);

      const result = await sweepNoShowEvidence();
      expect(result.minimized).toBeGreaterThanOrEqual(1);

      const [stored] = await storedReports(bookingId);
      expect(stored!.reporter_statement).toBeNull();
      expect(stored!.response_statement).toBeNull();
      expect(stored!.evidence).toEqual({});
      expect(stored!.location_signal).toBe('unavailable');

      // Retained: this is the record of a financial consequence and a Trust & Safety decision.
      expect(stored!.outcome).toBe('no_fault');
      expect(stored!.resolved_by_admin_id).not.toBeNull();
      expect(stored!.resolution_reason).toBe('ADMIN NOTE');
    });

    it('leaves a recently resolved report untouched', async () => {
      const { bookingId } = await resolvedReportWithStatements();
      await sweepNoShowEvidence();

      const [stored] = await storedReports(bookingId);
      expect(stored!.reporter_statement).toBe('REPORTER SECRET');
    });

    it('evidence cannot be rewritten, only removed', async () => {
      const { bookingId } = await resolvedReportWithStatements();
      const [stored] = await storedReports(bookingId);

      const { sql } = await import('drizzle-orm');
      await expect(
        getDb().execute(
          sql`UPDATE no_show_reports SET evidence = '{"tampered":true}'::jsonb WHERE id = ${stored!.id}`,
        ),
      ).rejects.toThrow();
      await expect(
        getDb().execute(sql`UPDATE no_show_reports SET reporter_statement = 'rewritten' WHERE id = ${stored!.id}`),
      ).rejects.toThrow();
    });

    it('history rows are append-only', async () => {
      const { reportId } = await resolvedReportWithStatements();
      const { sql } = await import('drizzle-orm');

      await expect(
        getDb().execute(
          sql`UPDATE no_show_reports_status_history SET to_status = 'withdrawn' WHERE no_show_report_id = ${reportId}`,
        ),
      ).rejects.toThrow();
      await expect(
        getDb().execute(sql`DELETE FROM no_show_reports_status_history WHERE no_show_report_id = ${reportId}`),
      ).rejects.toThrow();
    });
  });

  describe('the admin queue', () => {
    it('lists reports and filters by status', async () => {
      const { scenario, bookingId } = await seedReportableBooking();
      await reportNoShow({ userId: scenario.customer.userId, bookingId, mode: 'customer', idempotencyKey: uniqueKey() });

      const all = await listNoShowReportsForAdmin({ limit: 50, offset: 0 });
      expect(all.some((r) => r.bookingId === bookingId)).toBe(true);

      const awaiting = await listNoShowReportsForAdmin({ status: 'awaiting_response', limit: 50, offset: 0 });
      expect(awaiting.every((r) => r.status === 'awaiting_response')).toBe(true);
    });
  });
});
