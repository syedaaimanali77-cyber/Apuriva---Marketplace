import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { offers, users } from '@/lib/db/schema';
import { isDatabaseReachable } from '@/lib/db/test-support';
import { seedOfferScenario, sendOffer } from '@/lib/offers/offers-test-support';
import { cancelDeletion, getGracePeriodDays, REDACTED_DESCRIPTION, requestDeletion, sweepDeletions } from './deletion';
import { seedBooking, seedUser } from './test-support';

const dbReachable = await isDatabaseReachable();

describe.skipIf(!dbReachable)('lib/privacy/deletion (spec 008 AC-4, integration)', () => {
  const pool = getPool();

  afterAll(async () => {
    await pool.end();
  });

  it('getGracePeriodDays defaults to 14', () => {
    const original = process.env.DELETION_GRACE_PERIOD_DAYS;
    delete process.env.DELETION_GRACE_PERIOD_DAYS;
    expect(getGracePeriodDays()).toBe(14);
    process.env.DELETION_GRACE_PERIOD_DAYS = original;
  });

  it('getGracePeriodDays honors a valid server-side override', () => {
    const original = process.env.DELETION_GRACE_PERIOD_DAYS;
    process.env.DELETION_GRACE_PERIOD_DAYS = '7';
    expect(getGracePeriodDays()).toBe(7);
    process.env.DELETION_GRACE_PERIOD_DAYS = original;
  });

  // `hasActiveBooking` itself is tested in booking-lifecycle-adapter.integration.test.ts — this
  // file only tests that requestDeletion correctly delegates to it (below).

  it('AC-4: requestDeletion enters Deletion Pending with a grace period', async () => {
    const userId = await seedUser();
    const before = Date.now();
    const { gracePeriodEndsAt } = await requestDeletion(userId);

    const [row] = await getDb().select().from(users).where(eq(users.id, userId));
    expect(row!.lifecycleStatus).toBe('deletion_pending');
    expect(row!.deletionRequestedAt).not.toBeNull();
    expect(gracePeriodEndsAt.getTime()).toBeGreaterThan(before + 13 * 24 * 60 * 60 * 1000);
  });

  it('AC-4: an active booking blocks deletion with 422 ACTIVE_BOOKING_BLOCKS_DELETION, no pending state entered', async () => {
    const userId = await seedUser();
    await seedBooking(userId, 'in_progress');

    await expect(requestDeletion(userId)).rejects.toMatchObject({ code: 'ACTIVE_BOOKING_BLOCKS_DELETION', status: 422 });

    const [row] = await getDb().select().from(users).where(eq(users.id, userId));
    expect(row!.lifecycleStatus).toBe('active');
  });

  it('a repeat deletion request while already pending returns 409 DELETION_ALREADY_PENDING, not a second workflow', async () => {
    const userId = await seedUser();
    await requestDeletion(userId);

    await expect(requestDeletion(userId)).rejects.toMatchObject({ code: 'DELETION_ALREADY_PENDING', status: 409 });
  });

  it('cancelDeletion restores active status only for a pending deletion', async () => {
    const userId = await seedUser();
    await requestDeletion(userId);

    await cancelDeletion(userId);

    const [row] = await getDb().select().from(users).where(eq(users.id, userId));
    expect(row!.lifecycleStatus).toBe('active');
    expect(row!.deletionGraceEndsAt).toBeNull();
  });

  it('cancelDeletion throws 409 DELETION_NOT_PENDING when nothing is pending', async () => {
    const userId = await seedUser();
    await expect(cancelDeletion(userId)).rejects.toMatchObject({ code: 'DELETION_NOT_PENDING', status: 409 });
  });

  it('sweepDeletions anonymizes only accounts past their grace end, and preserves lifecycle for those not yet due', async () => {
    const dueUserId = await seedUser();
    await getDb()
      .update(users)
      .set({
        email: `due-${randomUUID()}@example.test`,
        lifecycleStatus: 'deletion_pending',
        deletionGraceEndsAt: new Date(Date.now() - 1000),
      })
      .where(eq(users.id, dueUserId));

    const notDueUserId = await seedUser();
    await getDb()
      .update(users)
      .set({
        email: `not-due-${randomUUID()}@example.test`,
        lifecycleStatus: 'deletion_pending',
        deletionGraceEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .where(eq(users.id, notDueUserId));

    const { processed } = await sweepDeletions();
    expect(processed).toBeGreaterThanOrEqual(1);

    const [due] = await getDb().select().from(users).where(eq(users.id, dueUserId));
    expect(due!.lifecycleStatus).toBe('deleted');
    expect(due!.email).toBeNull();

    const [notDue] = await getDb().select().from(users).where(eq(users.id, notDueUserId));
    expect(notDue!.lifecycleStatus).toBe('deletion_pending');
  });

  it('sweepDeletions is idempotent — running it again after anonymizing is a no-op for that account', async () => {
    const userId = await seedUser();
    await getDb()
      .update(users)
      .set({ lifecycleStatus: 'deletion_pending', deletionGraceEndsAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, userId));

    await sweepDeletions();
    await expect(sweepDeletions()).resolves.toBeDefined();

    const [row] = await getDb().select().from(users).where(eq(users.id, userId));
    expect(row!.lifecycleStatus).toBe('deleted');
  });

  it("cancelDeletion cannot undo deletion once the sweep has anonymized the account", async () => {
    const userId = await seedUser();
    await getDb()
      .update(users)
      .set({ lifecycleStatus: 'deletion_pending', deletionGraceEndsAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, userId));
    await sweepDeletions();

    await expect(cancelDeletion(userId)).rejects.toMatchObject({ code: 'DELETION_NOT_PENDING' });
  });

  it("spec 018 §4: a swept provider's offers are retained with provider_message redacted; price and timestamps kept", async () => {
    const { providers, requestId } = await seedOfferScenario();
    const provider = providers[0]!;
    const offer = await sendOffer(provider, requestId, { providerMessage: 'Call me on 0300-1234567' });

    await getDb()
      .update(users)
      .set({ lifecycleStatus: 'deletion_pending', deletionGraceEndsAt: new Date(Date.now() - 1000) })
      .where(eq(users.id, provider.userId));
    await sweepDeletions();

    const [row] = await getDb().select().from(offers).where(eq(offers.id, offer.id));
    expect(row).toBeDefined();
    expect(row!.providerMessage).toBe(REDACTED_DESCRIPTION);
    expect(row!.priceAmountMinorUnits).toBe(320_000);
    expect(row!.priceCurrencyCode).toBe('PKR');
    expect(row!.sentAt).not.toBeNull();
    expect(row!.expiresAt).not.toBeNull();
  });
});
