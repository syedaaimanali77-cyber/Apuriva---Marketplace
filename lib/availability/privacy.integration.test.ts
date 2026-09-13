import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { getDb, getPool } from '@/lib/db';
import { providerAvailabilityNotificationRequests, users } from '@/lib/db/schema';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { generateExportPayload } from '@/lib/privacy/export';
import { sweepDeletions } from '@/lib/privacy/deletion';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { PUT as PUT_SCHEDULE } from '@/app/api/v1/providers/me/availability/schedule/route';
import { POST as CREATE_OVERRIDE } from '@/app/api/v1/providers/me/availability/overrides/route';
import { PUT as PUT_AREAS } from '@/app/api/v1/providers/me/service-areas/route';
import { POST as NOTIFY } from '@/app/api/v1/providers/[id]/availability-notify/route';
import {
  LAHORE,
  registerCustomer,
  registerProvider,
  seedAddressAt,
  sessionMutate,
} from '@/app/api/v1/providers/availability-test-support';

const dbReachable = await isDatabaseReachable();

const SCHEDULE_URL = 'http://localhost/api/v1/providers/me/availability/schedule';
const OVERRIDES_URL = 'http://localhost/api/v1/providers/me/availability/overrides';
const AREAS_URL = 'http://localhost/api/v1/providers/me/service-areas';

/**
 * Spec 016 §4 "Retention and privacy" — the schedule/coverage rows integrate with spec 008's
 * EXISTING export and deletion mechanism; no new privacy path is introduced.
 */
describe.skipIf(!dbReachable)('spec 016 privacy integration (export + deletion)', () => {
  afterAll(async () => {
    await getPool().end();
  });

  it("includes the provider's own schedule, overrides and service areas in their data export", async () => {
    resetRateLimitState();
    const provider = await registerProvider();
    const { addressId } = await seedAddressAt(provider.userId, LAHORE, 'Lahore');

    await PUT_SCHEDULE(
      sessionMutate(SCHEDULE_URL, provider, 'PUT', {
        timezone: 'Asia/Karachi',
        entries: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1080 }],
      }),
    );
    await CREATE_OVERRIDE(sessionMutate(OVERRIDES_URL, provider, 'POST', { date: '2026-09-18', isAvailable: false }));
    await PUT_AREAS(
      sessionMutate(AREAS_URL, provider, 'PUT', { areas: [{ mode: 'radius', radiusKm: 20, centerAddressId: addressId }] }),
    );

    const payload = await generateExportPayload(provider.userId);

    expect(payload.providerAvailability).not.toBeNull();
    expect(payload.providerAvailability!.timezone).toBe('Asia/Karachi');
    expect(payload.providerAvailability!.weeklyEntries).toEqual([{ dayOfWeek: 1, startMinute: 540, endMinute: 1080 }]);
    expect(payload.providerAvailability!.overrides).toEqual([
      { date: '2026-09-18', isAvailable: false, startMinute: null, endMinute: null },
    ]);
    expect(payload.providerAvailability!.serviceAreas).toEqual([
      { serviceId: null, mode: 'radius', radiusMeters: 20_000, centerAddressId: addressId, cities: null },
    ]);
  });

  it("excludes another provider's schedule from a user's export", async () => {
    resetRateLimitState();
    const providerA = await registerProvider();
    const providerB = await registerProvider();

    await PUT_SCHEDULE(
      sessionMutate(SCHEDULE_URL, providerA, 'PUT', {
        timezone: 'Asia/Karachi',
        entries: [{ dayOfWeek: 4, startMinute: 600, endMinute: 700 }],
      }),
    );

    const payload = await generateExportPayload(providerB.userId);
    expect(payload.providerAvailability!.weeklyEntries).toEqual([]);
  });

  it('exports nothing for a user with no provider profile, without failing', async () => {
    resetRateLimitState();
    const customer = await registerCustomer();
    const payload = await generateExportPayload(customer.userId);
    expect(payload.providerAvailability).toBeNull();
    expect(payload.availabilityNotifications).toEqual([]);
  });

  it("exports the customer's own availability-notification opt-ins", async () => {
    resetRateLimitState();
    const provider = await registerProvider();
    const customer = await registerCustomer();

    await NOTIFY(sessionMutate(`http://localhost/api/v1/providers/${provider.providerProfileId}/availability-notify`, customer, 'POST'));

    const payload = await generateExportPayload(customer.userId);
    expect(payload.availabilityNotifications).toHaveLength(1);
    expect(payload.availabilityNotifications[0]).toMatchObject({
      providerProfileId: provider.providerProfileId,
      status: 'pending',
    });
  });

  it('cancels pending availability notifications when the customer is deleted, so spec 026 can never notify a deleted account', async () => {
    resetRateLimitState();
    const provider = await registerProvider();
    const customer = await registerCustomer();

    const created = await NOTIFY(
      sessionMutate(`http://localhost/api/v1/providers/${provider.providerProfileId}/availability-notify`, customer, 'POST'),
    );
    const notificationId = (await created.json()).data.id;

    // Put the account past its deletion grace period, the state the sweep acts on.
    await getDb()
      .update(users)
      .set({ lifecycleStatus: 'deletion_pending', deletionGraceEndsAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, customer.userId));

    await sweepDeletions();

    const [row] = await getDb()
      .select({ status: providerAvailabilityNotificationRequests.status })
      .from(providerAvailabilityNotificationRequests)
      .where(eq(providerAvailabilityNotificationRequests.id, notificationId));

    expect(row!.status).toBe('cancelled');
  });

  it("retains the provider's schedule rows through deletion, keyed to the anonymized profile", async () => {
    resetRateLimitState();
    const provider = await registerProvider();
    await PUT_SCHEDULE(
      sessionMutate(SCHEDULE_URL, provider, 'PUT', {
        timezone: 'Asia/Karachi',
        entries: [{ dayOfWeek: 2, startMinute: 540, endMinute: 1080 }],
      }),
    );

    await getDb()
      .update(users)
      .set({ lifecycleStatus: 'deletion_pending', deletionGraceEndsAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, provider.userId));
    await sweepDeletions();

    // The rows survive — they carry no PII of their own and every FK in this schema is `restrict`.
    const payload = await generateExportPayload(provider.userId);
    expect(payload.providerAvailability!.weeklyEntries).toHaveLength(1);
    expect(payload.profile.providerProfile!.businessName).toBeNull();
  });

  it('leaves an unrelated customer\'s pending notification untouched by another account\'s deletion', async () => {
    resetRateLimitState();
    const provider = await registerProvider();
    const deleting = await registerCustomer();
    const bystander = await registerCustomer();
    const url = `http://localhost/api/v1/providers/${provider.providerProfileId}/availability-notify`;

    await NOTIFY(sessionMutate(url, deleting, 'POST'));
    const kept = await NOTIFY(sessionMutate(url, bystander, 'POST'));
    const keptId = (await kept.json()).data.id;

    await getDb()
      .update(users)
      .set({ lifecycleStatus: 'deletion_pending', deletionGraceEndsAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, deleting.userId));
    await sweepDeletions();

    const [row] = await getDb()
      .select({ status: providerAvailabilityNotificationRequests.status })
      .from(providerAvailabilityNotificationRequests)
      .where(
        and(
          eq(providerAvailabilityNotificationRequests.id, keptId),
          eq(providerAvailabilityNotificationRequests.status, 'pending'),
        ),
      );
    expect(row).toBeDefined();
  });
});
