import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '@/lib/db';
import { resetBusyIntervalLoader } from '@/lib/availability/busy-intervals';
import { registerBookingBusyIntervals, resetBookingBusyIntervalsRegistration } from '@/lib/bookings/busy-intervals';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { grantRole, registerAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import { guestGet, sessionGet, sessionMutate } from '@/app/api/v1/providers/availability-test-support';
import { POST as CANCEL } from '@/app/api/v1/bookings/[id]/cancel/route';
import { GET as CANCEL_PREVIEW } from '@/app/api/v1/bookings/[id]/cancel-preview/route';
import { GET as BOOKING_POLICY } from '@/app/api/v1/bookings/[id]/cancellation-policy/route';
import { GET as SERVICE_POLICY } from '@/app/api/v1/services/[id]/cancellation-policy/route';
import { POST as REPORT_NO_SHOW } from '@/app/api/v1/bookings/[id]/report-no-show/route';
import { GET as ADMIN_POLICIES, POST as PUBLISH_POLICY } from '@/app/api/v1/admin/cancellation-policies/route';
import { GET as ADMIN_REPORTS } from '@/app/api/v1/admin/no-show-reports/route';
import {
  bookingScope,
  isDatabaseReachable,
  makeReportable,
  resetCancellationIntegration,
  seedCapturedBooking,
  setHoursBeforeScheduled,
  uniqueKey,
  useCancellationIntegration,
} from './cancellation-test-support';

const dbReachable = await isDatabaseReachable();
const SUITE_TIMEOUT_MS = 90_000;

afterAll(async () => {
  await getPool().end();
});

async function bodyOf(response: Response): Promise<{ data?: unknown; code?: string; message?: string }> {
  return (await response.json()) as { data?: unknown; code?: string; message?: string };
}

/** Adds the `Idempotency-Key` the financially consequential routes require. */
function withKey(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set('Idempotency-Key', uniqueKey());
  return new Request(request, { headers });
}

describe.skipIf(!dbReachable)('spec 023 routes', { timeout: SUITE_TIMEOUT_MS }, () => {
  beforeEach(() => {
    useCancellationIntegration();
    registerBookingBusyIntervals();
  });

  afterEach(() => {
    resetCancellationIntegration();
    resetBusyIntervalLoader();
    resetBookingBusyIntervalsRegistration();
  });

  describe('guards (AC-3, AC-8)', () => {
    it('requires a session', async () => {
      const { bookingId } = await seedCapturedBooking();
      const response = await CANCEL(
        new Request(`http://localhost/api/v1/bookings/${bookingId}/cancel`, { method: 'POST', body: '{}' }),
      );
      expect(response.status).toBe(401);
    });

    /** The session cookie alone is not enough: the CSRF header is stripped, so the guard must fire. */
    it('requires CSRF on a mutation', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      const authenticated = sessionMutate(
        `http://localhost/api/v1/bookings/${bookingId}/cancel`,
        scenario.customer,
        'POST',
        {},
      );
      const headers = new Headers(authenticated.headers);
      headers.delete('x-csrf-token');

      const response = await CANCEL(new Request(authenticated, { headers }));
      expect(response.status).toBe(403);
    });

    it('requires an Idempotency-Key', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      const response = await CANCEL(
        sessionMutate(`http://localhost/api/v1/bookings/${bookingId}/cancel`, scenario.customer, 'POST', {}),
      );
      expect(response.status).toBe(400);
      expect((await bodyOf(response)).code).toBe('VALIDATION_ERROR');
    });

    /**
     * AC-3 at the edge of the system: a body that tries to name its own fee is REJECTED, not
     * quietly ignored — a caller must never be left believing they set a price.
     */
    it('rejects a client-supplied fee, tier or timestamp outright', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 18);

      for (const body of [
        { feeAmountMinorUnits: 0 },
        { refundAmountMinorUnits: 999_999 },
        { feePercent: 0 },
        { tier: { feePercent: 0 } },
        { hoursBefore: 100 },
        { cancelledAt: new Date().toISOString() },
        { policyVersionId: 'someone-elses-policy' },
      ]) {
        const response = await CANCEL(
          withKey(sessionMutate(`http://localhost/api/v1/bookings/${bookingId}/cancel`, scenario.customer, 'POST', body)),
        );
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect((await bodyOf(response)).code).toBe('VALIDATION_ERROR');
      }
    });

    it('accepts a reason code and a note, which change nothing about the money', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 18);

      const response = await CANCEL(
        withKey(
          sessionMutate(`http://localhost/api/v1/bookings/${bookingId}/cancel`, scenario.customer, 'POST', {
            reasonCode: 'plans_changed',
            note: 'Sorry!',
          }),
        ),
      );
      expect(response.status).toBe(200);
      const data = (await bodyOf(response)).data as { feeAmountMinorUnits: number; reasonCode: string };
      expect(data.reasonCode).toBe('plans_changed');
      expect(data.feeAmountMinorUnits).toBeGreaterThan(0);
    });
  });

  describe('reads', () => {
    it('serves the service policy to a guest', async () => {
      const { bookingId } = await seedCapturedBooking();
      const { serviceId } = await bookingScope(bookingId);
      resetRateLimitState();

      const response = await SERVICE_POLICY(guestGet(`http://localhost/api/v1/services/${serviceId}/cancellation-policy`));
      expect(response.status).toBe(200);
      const data = (await bodyOf(response)).data as { tiers: unknown[]; source: string };
      expect(data.source).toBe('platform_default');
      expect(data.tiers).toHaveLength(4);
    });

    it('serves the booking-scoped snapshot to a participant', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      const response = await BOOKING_POLICY(
        sessionGet(`http://localhost/api/v1/bookings/${bookingId}/cancellation-policy`, scenario.customer),
      );
      expect(response.status).toBe(200);
      const data = (await bodyOf(response)).data as { snapshotAsOf: string };
      expect(data.snapshotAsOf).toBeTruthy();
    });

    it('previews the consequence without mutating the booking', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await setHoursBeforeScheduled(bookingId, 18);

      const response = await CANCEL_PREVIEW(
        sessionGet(`http://localhost/api/v1/bookings/${bookingId}/cancel-preview`, scenario.customer),
      );
      expect(response.status).toBe(200);
      const data = (await bodyOf(response)).data as { cancellable: boolean; feeAmountMinorUnits: number };
      expect(data.cancellable).toBe(true);
      expect(data.feeAmountMinorUnits).toBeGreaterThan(0);
    });
  });

  describe('no-show routes', () => {
    it('creates a report with 201', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await makeReportable(bookingId, 60);

      const response = await REPORT_NO_SHOW(
        withKey(
          sessionMutate(`http://localhost/api/v1/bookings/${bookingId}/report-no-show`, scenario.customer, 'POST', {
            statement: 'Nobody came.',
          }),
        ),
      );
      expect(response.status).toBe(201);
      const data = (await bodyOf(response)).data as { status: string; outcome: null };
      expect(data.status).toBe('awaiting_response');
      expect(data.outcome).toBeNull();
    });

    it('never serves admin fields from a participant route', async () => {
      const { scenario, bookingId } = await seedCapturedBooking();
      await makeReportable(bookingId, 60);
      const response = await REPORT_NO_SHOW(
        withKey(
          sessionMutate(`http://localhost/api/v1/bookings/${bookingId}/report-no-show`, scenario.customer, 'POST', {
            statement: 'PRIVATE WORDS',
          }),
        ),
      );

      const serialized = JSON.stringify((await bodyOf(response)).data);
      expect(serialized).not.toContain('PRIVATE WORDS');
      expect(serialized).not.toMatch(/evidence|locationSignal|resolutionReason|resolvedByAdminId/);
    });
  });

  describe('admin routes (AC-9)', () => {
    it('refuses an admin without the permission', async () => {
      resetRateLimitState();
      const admin = await registerAdmin();
      await grantRole(admin, 'content_admin');
      resetRateLimitState();

      const response = await ADMIN_REPORTS(sessionGet('http://localhost/api/v1/admin/no-show-reports', admin));
      expect(response.status).toBe(403);
    });

    it('serves the queue to Trust & Safety', async () => {
      resetRateLimitState();
      const admin = await registerAdmin();
      await grantRole(admin, 'trust_safety_admin');
      resetRateLimitState();

      const response = await ADMIN_REPORTS(sessionGet('http://localhost/api/v1/admin/no-show-reports', admin));
      expect(response.status).toBe(200);
    });

    it('publishes a new policy version and refuses a caller-chosen effective instant', async () => {
      resetRateLimitState();
      const admin = await registerAdmin();
      await grantRole(admin, 'operations_admin');
      resetRateLimitState();

      const { bookingId } = await seedCapturedBooking();
      const { serviceId } = await bookingScope(bookingId);
      const config = {
        tiers: [
          { minHoursBefore: 48, maxHoursBefore: null, feePercent: 0 },
          { minHoursBefore: null, maxHoursBefore: 48, feePercent: 30 },
        ],
        allowedOptions: [],
      };

      const rejected = await PUBLISH_POLICY(
        sessionMutate('http://localhost/api/v1/admin/cancellation-policies', admin, 'POST', {
          scope: 'service',
          scopeId: serviceId,
          config,
          effectiveFrom: '2020-01-01T00:00:00Z',
        }),
      );
      expect(rejected.status).toBe(400);

      const created = await PUBLISH_POLICY(
        sessionMutate('http://localhost/api/v1/admin/cancellation-policies', admin, 'POST', {
          scope: 'service',
          scopeId: serviceId,
          config,
          note: 'Stricter for this service',
        }),
      );
      expect(created.status).toBe(201);

      const listed = await ADMIN_POLICIES(sessionGet('http://localhost/api/v1/admin/cancellation-policies', admin));
      expect(listed.status).toBe(200);
      const policies = (await bodyOf(listed)).data as Array<{ scope: string; versions: unknown[] }>;
      expect(policies.some((p) => p.scope === 'service')).toBe(true);
    });

    it('rejects an invalid configuration with field-level errors', async () => {
      resetRateLimitState();
      const admin = await registerAdmin();
      await grantRole(admin, 'operations_admin');
      resetRateLimitState();

      const response = await PUBLISH_POLICY(
        sessionMutate('http://localhost/api/v1/admin/cancellation-policies', admin, 'POST', {
          scope: 'platform',
          config: { tiers: [{ minHoursBefore: 24, maxHoursBefore: 48, feePercent: 0 }] },
        }),
      );
      expect(response.status).toBe(422);
      expect((await bodyOf(response)).code).toBe('POLICY_CONFIG_INVALID');
    });
  });
});

/** Spec 004 AC-7 — every spec 023 route is documented, or `check:openapi-drift` would fail in CI. */
describe('OpenAPI registration (spec 023 §3)', () => {
  const EXPECTED: Array<[string, string]> = [
    ['GET', '/services/{id}/cancellation-policy'],
    ['GET', '/bookings/{id}/cancellation-policy'],
    ['GET', '/bookings/{id}/cancel-preview'],
    ['POST', '/bookings/{id}/cancel'],
    ['POST', '/bookings/{id}/report-no-show'],
    ['GET', '/bookings/{id}/no-show-reports'],
    ['POST', '/no-show-reports/{id}/respond'],
    ['POST', '/no-show-reports/{id}/withdraw'],
    ['GET', '/admin/no-show-reports'],
    ['GET', '/admin/no-show-reports/{id}'],
    ['POST', '/admin/no-show-reports/{id}/resolve'],
    ['GET', '/admin/cancellation-policies'],
    ['POST', '/admin/cancellation-policies'],
    ['PUT', '/providers/me/services/{id}/cancellation-option'],
  ];

  for (const [method, path] of EXPECTED) {
    it(`registers ${method} ${path}`, () => {
      const entry = OPENAPI_ROUTES.find((route) => route.method === method && route.path === path);
      expect(entry, `${method} ${path} is missing from OPENAPI_ROUTES`).toBeDefined();
      expect(entry!.tags).toSatisfy((tags: string[]) => tags.includes('cancellation') || tags.includes('no-show'));
    });
  }

  /** Cron routes are platform infrastructure and are excluded from the contract, as every other is. */
  it('does not document the response-timeout cron route', () => {
    expect(OPENAPI_ROUTES.some((route) => route.path.includes('cron'))).toBe(false);
  });
});
