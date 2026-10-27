/**
 * Spec 045 §3.3 (AC-2, AC-4, AC-5, AC-6) — provisions ONE fresh, private demo set.
 *
 * Shape of a call:
 *   1. Read the 0006 catalog (read-only) and the effective cancellation policy (spec 023, read-only).
 *   2. Phase A — every external round trip, OUTSIDE any transaction, through the configured adapters:
 *      spec 021's payment port (`resolvePaymentProvider()`; the sandbox still refuses under
 *      `NODE_ENV=production` — DEP-1 is not worked around), and spec 027's storage + scanner for the bundled
 *      portfolio placeholder.
 *   3. Phase B — ONE transaction that writes the whole set. Any failure rolls every row back, so nothing is
 *      ever partially provisioned and a reset that fails leaves the caller's old set and session untouched.
 *
 * It only ever INSERTs new rows and walks the new rows' statuses: no existing row is updated or deleted, so
 * no other visitor's set and no non-demo data can be affected (AC-5). Seeded relationships only link users
 * of the same set. The only rows shared with other sets are the read-only catalog and policy rows.
 *
 * Every seeded contact address is undeliverable (`.invalid`) and seeded notifications are inbox rows only:
 * no `notification_deliveries` row is created, so the dispatcher has nothing to send (AC-6).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { ensurePolicyAcceptance, resolveEffectivePolicy } from '@/lib/cancellation/resolution';
import { computeCancellationConsequence, toHoursBeforeMilli } from '@/lib/cancellation/tiers';
import { resolveFileStorageAdapter } from '@/lib/files/storage';
import { resolveFileScanner } from '@/lib/files/scanning';
import { renderNotification } from '@/lib/notifications/catalogue';
import { registerRefundIntegration } from '@/lib/refunds';
import { resolveReviewEligibility } from '@/lib/reviews/eligibility';
import { evaluateReviewSignals } from '@/lib/reviews/signals';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import type { DemoPersona } from '@/lib/types/demo';
import type { NotificationParams } from '@/lib/types/notifications';
import { loadDemoCatalog, service, type DemoCatalog } from './seed/catalog';
import {
  callPaymentAdapter,
  failAbandonedPayment,
  moveProtection,
  openProtection,
  recordPayment,
  recordRefund,
  type AdapterOutcome,
  type PaymentPlan,
  type RecordedPayment,
} from './seed/payments';
import { placeholderImageBytes, PLACEHOLDER_IMAGE_MIME } from './seed/placeholder';
import { bookingTimeline, demoCurrency, setPlanFor, type BookingPlan, type RequestPlan, type SetPlan } from './seed/scenarios';
import {
  insertAddress,
  insertDemoPerson,
  insertMatch,
  insertOverride,
  insertPackage,
  insertPendingBooking,
  insertProviderService,
  insertSentOffer,
  insertSubmittedRequest,
  insertWeeklyHours,
  offerDecisionColumns,
  walkStatus,
  type DemoPerson,
} from './seed/writers';
import { addDays } from '@/lib/availability/timezone';

export interface ProvisionedDemoSet {
  setId: string;
  persona: DemoPersona;
  personaUserId: string;
  /** Every user of the set, by plan key — for tests and the operator log. */
  userIds: Record<string, string>;
  bookingIds: Record<string, string>;
  requestIds: Record<string, string>;
}

/** Days a provider marked `unavailable` has blocked, starting today (spec 016 R3 overrides). */
const UNAVAILABLE_DAYS = 14;

interface CancellationFigures {
  hoursBefore: number;
  feeAmountMinorUnits: number;
  refundAmountMinorUnits: number;
  refundId: string;
}

/**
 * The transitions this seed records through other specs' primitives must be registered, as
 * `instrumentation.ts` registers them in a server: spec 022's payment transitions into `refunded` and
 * `partially_refunded`. Importing the barrel registers them (idempotently); calling it states the dependency.
 */
function ensureRegistrations(): void {
  registerRefundIntegration();
}

export async function provisionDemoSet(persona: DemoPersona, options: { now?: Date } = {}): Promise<ProvisionedDemoSet> {
  ensureRegistrations();
  const now = options.now ?? new Date();
  const db = getDb();
  const catalog = await loadDemoCatalog(db);
  const plan = setPlanFor(persona, now);
  const setId = randomUUID();

  // Pre-generated ids: the storage keys and the refund idempotency keys must exist before the transaction.
  const userIds: Record<string, string> = Object.fromEntries(plan.people.map((person) => [person.key, randomUUID()]));

  const cancellations = await planCancellations(db, catalog, plan);
  const paymentPlans = plan.bookings.map((booking) => paymentPlanFor(booking, cancellations.get(booking.key)));

  // Phase A — outside any transaction.
  const adapterOutcomes = await callPaymentAdapter(paymentPlans);
  const portfolio = await storePortfolioPlaceholders(plan, userIds);

  // Phase B — one transaction for the whole set.
  return db.transaction(async (tx) => {
    const writer = new SetWriter(tx, setId, plan, catalog, userIds, now);
    await writer.writePeople();
    await writer.writeProviders(portfolio);
    for (const request of plan.requests) await writer.writeRequest(request);
    for (const booking of plan.bookings) {
      await writer.writeBooking(booking, paymentPlans.find((p) => p.key === booking.key)!, adapterOutcomes.get(booking.key)!, cancellations.get(booking.key));
    }
    await writer.writeReviews();
    await writer.writeNotifications();
    return {
      setId,
      persona,
      personaUserId: writer.person(plan.personaKey).userId,
      userIds,
      bookingIds: writer.bookingIds,
      requestIds: writer.requestIds,
    };
  });
}

/** The amount each booking authorizes, and the refund spec 023's fee ladder leaves for a cancellation. */
function paymentPlanFor(booking: BookingPlan, cancellation: CancellationFigures | undefined): PaymentPlan {
  return {
    key: booking.key,
    amountMinorUnits: booking.priceAmountMinorUnits,
    currencyCode: demoCurrency(),
    refunds: cancellation && cancellation.refundAmountMinorUnits > 0
      ? [{ refundId: cancellation.refundId, amountMinorUnits: cancellation.refundAmountMinorUnits }]
      : [],
  };
}

/**
 * Spec 023's consequence for each cancelled/refunded booking, computed BEFORE the transaction so the
 * adapter can be asked for exactly that refund. The same resolution is materialised inside the transaction
 * by `ensurePolicyAcceptance` — versions are immutable, so both reads agree.
 */
async function planCancellations(db: Executor, catalog: DemoCatalog, plan: SetPlan): Promise<Map<string, CancellationFigures>> {
  const figures = new Map<string, CancellationFigures>();
  for (const booking of plan.bookings) {
    if (!booking.cancelledAt) continue;
    const policy = await resolveEffectivePolicy(db, service(catalog, booking.slug).serviceId, booking.bookedAt);
    const hoursBefore = (booking.scheduledAt.getTime() - booking.cancelledAt.getTime()) / 3_600_000;
    const consequence = computeCancellationConsequence({ tiers: policy.tiers, hoursBefore, capturedAmountMinorUnits: booking.priceAmountMinorUnits });
    if (!consequence) throw new Error(`demo seed: no cancellation tier for ${booking.key}`);
    figures.set(booking.key, {
      hoursBefore,
      feeAmountMinorUnits: consequence.feeAmountMinorUnits,
      refundAmountMinorUnits: consequence.refundAmountMinorUnits,
      refundId: randomUUID(),
    });
  }
  return figures;
}

interface StoredPlaceholder {
  fileAssetId: string;
  storageKey: string;
  sizeBytes: number;
  ownerKey: string;
}

/** Spec 027 — the placeholder written through the configured storage adapter and scanned by the configured scanner. */
async function storePortfolioPlaceholders(plan: SetPlan, userIds: Record<string, string>): Promise<StoredPlaceholder[]> {
  const storage = resolveFileStorageAdapter();
  const scanner = resolveFileScanner();
  const bytes = placeholderImageBytes();
  const stored: StoredPlaceholder[] = [];

  for (const provider of plan.providers) {
    for (let index = 0; index < provider.portfolioCount; index += 1) {
      const fileAssetId = randomUUID();
      const storageKey = `${userIds[provider.key]}/${fileAssetId}`;
      await storage.write(storageKey, bytes, PLACEHOLDER_IMAGE_MIME);
      const scan = await scanner.scan({ fileAssetId, storageKey, mimeType: PLACEHOLDER_IMAGE_MIME, sizeBytes: bytes.length });
      // A placeholder the scanner does not call clean is simply not shown — never marked ready regardless.
      if (scan.outcome === 'clean') stored.push({ fileAssetId, storageKey, sizeBytes: bytes.length, ownerKey: provider.key });
    }
  }
  return stored;
}

/** Writes one plan inside the provisioning transaction, remembering the ids later steps refer to. */
class SetWriter {
  private readonly people = new Map<string, DemoPerson>();
  private readonly addresses = new Map<string, string>();
  readonly bookingIds: Record<string, string> = {};
  readonly requestIds: Record<string, string> = {};
  private readonly reviewIds: Record<string, string> = {};
  private readonly disputeIds: Record<string, string> = {};
  private readonly refundIds: Record<string, string> = {};
  private readonly refundAmounts: Record<string, { refund: number; fee: number }> = {};

  constructor(
    private readonly tx: Executor,
    private readonly setId: string,
    private readonly plan: SetPlan,
    private readonly catalog: DemoCatalog,
    private readonly userIds: Record<string, string>,
    private readonly now: Date,
  ) {}

  person(key: string): DemoPerson {
    const found = this.people.get(key);
    if (!found) throw new Error(`demo seed: unknown person ${key}`);
    return found;
  }

  private providerProfileId(key: string): string {
    const id = this.person(key).providerProfileId;
    if (!id) throw new Error(`demo seed: ${key} is not a provider`);
    return id;
  }

  async writePeople(): Promise<void> {
    const createdAt = new Date(this.now.getTime() - 30 * 86_400_000);
    for (const person of this.plan.people) {
      const written = await insertDemoPerson(this.tx, {
        setId: this.setId,
        userId: this.userIds[person.key],
        name: person.name,
        businessName: person.businessName,
        createdAt,
      });
      this.people.set(person.key, written);
      this.addresses.set(person.key, await insertAddress(this.tx, written.userId, person.place));
    }
  }

  async writeProviders(portfolio: StoredPlaceholder[]): Promise<void> {
    for (const provider of this.plan.providers) {
      const providerProfileId = this.providerProfileId(provider.key);
      for (const offered of provider.services) {
        await insertProviderService(this.tx, {
          providerProfileId,
          serviceId: service(this.catalog, offered.slug).serviceId,
          durationMinutes: offered.durationMinutes,
        });
      }
      for (const pkg of provider.packages) {
        await insertPackage(this.tx, {
          providerProfileId,
          serviceId: service(this.catalog, pkg.slug).serviceId,
          name: pkg.name,
          description: pkg.description,
          amountMinorUnits: pkg.amountMinorUnits,
          currencyCode: demoCurrency(),
          includedItems: pkg.includedItems,
        });
      }

      // Spec 016 R9's state is derived live, from these rows plus the bookings below.
      if (provider.availability === 'unavailable') {
        await insertWeeklyHours(this.tx, providerProfileId, { startMinute: 480, endMinute: 1200 });
        for (let day = 0; day < UNAVAILABLE_DAYS; day += 1) {
          await insertOverride(this.tx, { providerProfileId, date: addDays(this.plan.today, day), window: null });
        }
      } else {
        await insertWeeklyHours(this.tx, providerProfileId, { startMinute: 0, endMinute: 1440 });
        if (provider.availability === 'busy') {
          // Today's only window starts at the current slot; the in-progress job below fills all of it.
          await insertOverride(this.tx, {
            providerProfileId,
            date: this.plan.today,
            window: { startMinute: this.plan.busyStartMinute, endMinute: 1440 },
          });
        }
      }

      for (const asset of portfolio.filter((item) => item.ownerKey === provider.key)) {
        await this.tx.execute(sql`
          INSERT INTO file_assets (
            id, uploaded_by_user_id, kind, visibility, status, storage_key, mime_type, size_bytes, file_name,
            context_type, context_id, scan_outcome, scan_attempts, ready_at
          ) VALUES (
            ${asset.fileAssetId}, ${this.person(provider.key).userId}, 'image', 'public', 'ready', ${asset.storageKey},
            ${PLACEHOLDER_IMAGE_MIME}, ${asset.sizeBytes}, 'portfolio-placeholder.png',
            'portfolio', ${providerProfileId}, 'clean', 1, ${this.now.toISOString()}::timestamptz
          )
        `);
      }
    }
  }

  private async newRequest(customerKey: string, slug: BookingPlan['slug'], description: string, createdAt: Date, preferredAt: Date | null): Promise<string> {
    const catalogService = service(this.catalog, slug);
    return insertSubmittedRequest(this.tx, {
      setId: this.setId,
      customer: this.person(customerKey),
      serviceId: catalogService.serviceId,
      addressId: this.addresses.get(customerKey)!,
      detailsFieldId: catalogService.detailsFieldId,
      description,
      details: description,
      budget: null,
      preferredAt,
      createdAt,
    });
  }

  async writeRequest(request: RequestPlan): Promise<void> {
    const customer = this.person(request.customerKey);
    const requestId = await this.newRequest(request.customerKey, request.slug, request.description, request.createdAt, null);
    this.requestIds[request.key] = requestId;

    let status = 'submitted';
    if (request.matchedProviderKeys.length > 0) {
      const matchedAt = new Date(request.createdAt.getTime() + 60_000);
      status = await walkStatus(this.tx, 'requests', requestId, status, [{ to: 'matching', at: matchedAt, actorUserId: null }]);
      for (const [index, key] of request.matchedProviderKeys.entries()) {
        const firstOffer = request.offers.filter((o) => o.providerKey === key).sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())[0];
        await insertMatch(this.tx, {
          requestId,
          providerProfileId: this.providerProfileId(key),
          rank: index + 1,
          notifiedAt: new Date(matchedAt.getTime() + 30_000),
          offerSentAt: firstOffer?.sentAt ?? null,
        });
      }
    }

    for (const offer of [...request.offers].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())) {
      const provider = this.person(offer.providerKey);
      const offerId = await insertSentOffer(this.tx, {
        setId: this.setId,
        requestId,
        provider,
        priceAmountMinorUnits: offer.priceAmountMinorUnits,
        currencyCode: demoCurrency(),
        includedItems: ['Materials quoted separately'],
        providerMessage: 'Happy to help. I can come at a time that suits you.',
        estimatedDurationMinutes: 60,
        sentAt: offer.sentAt,
      });
      if (status === 'matching') {
        status = await walkStatus(this.tx, 'requests', requestId, status, [{ to: 'offers_open', at: offer.sentAt, actorUserId: provider.userId }]);
      }
      const decidedAt = offer.decidedAt ?? offer.sentAt;
      if (offer.status === 'viewed') {
        await walkStatus(this.tx, 'offers', offerId, 'sent', [{ to: 'viewed', at: decidedAt, actorUserId: customer.userId, set: offerDecisionColumns('viewed', decidedAt) }]);
      } else if (offer.status === 'accepted') {
        await walkStatus(this.tx, 'offers', offerId, 'sent', [
          { to: 'viewed', at: new Date(decidedAt.getTime() - 60_000), actorUserId: customer.userId, set: offerDecisionColumns('viewed', new Date(decidedAt.getTime() - 60_000)) },
          { to: 'accepted', at: decidedAt, actorUserId: customer.userId, set: offerDecisionColumns('accepted', decidedAt) },
        ]);
        status = await walkStatus(this.tx, 'requests', requestId, status, [{ to: 'provider_selected', at: decidedAt, actorUserId: customer.userId }]);
      } else if (offer.status === 'declined') {
        await walkStatus(this.tx, 'offers', offerId, 'sent', [{ to: 'declined', at: decidedAt, actorUserId: customer.userId, set: offerDecisionColumns('declined', decidedAt) }]);
      } else if (offer.status === 'withdrawn') {
        await walkStatus(this.tx, 'offers', offerId, 'sent', [{ to: 'withdrawn', at: decidedAt, actorUserId: provider.userId, set: offerDecisionColumns('withdrawn', decidedAt) }]);
      } else if (offer.status === 'expired') {
        // Spec 018's sweep: the two-minute window has passed, so the offer moves to `expired` (no actor).
        const expiredAt = new Date(offer.sentAt.getTime() + 2 * 60_000 + 30_000);
        await walkStatus(this.tx, 'offers', offerId, 'sent', [{ to: 'expired', at: expiredAt, actorUserId: null }]);
      }
    }

    if (request.status === 'cancelled') {
      await walkStatus(this.tx, 'requests', requestId, status, [{ to: 'cancelled', at: request.cancelledAt!, actorUserId: customer.userId }]);
    }
  }

  async writeBooking(plan: BookingPlan, paymentPlan: PaymentPlan, outcome: AdapterOutcome, cancellation: CancellationFigures | undefined): Promise<void> {
    const customer = this.person(plan.customerKey);
    const provider = this.person(plan.providerKey);
    const providerProfileId = this.providerProfileId(plan.providerKey);
    const catalogService = service(this.catalog, plan.slug);
    const time = bookingTimeline(plan);

    // Spec 015 → 017 → 018: the request, its distribution, and the accepted offer the booking is made from.
    const requestId = await this.newRequest(plan.customerKey, plan.slug, plan.description, time.requestCreatedAt, plan.scheduledAt);
    await walkStatus(this.tx, 'requests', requestId, 'submitted', [{ to: 'matching', at: new Date(time.requestCreatedAt.getTime() + 60_000), actorUserId: null }]);
    await insertMatch(this.tx, { requestId, providerProfileId, rank: 1, notifiedAt: new Date(time.requestCreatedAt.getTime() + 90_000), offerSentAt: time.offerSentAt });
    const offerId = await insertSentOffer(this.tx, {
      setId: this.setId,
      requestId,
      provider,
      priceAmountMinorUnits: plan.priceAmountMinorUnits,
      currencyCode: demoCurrency(),
      includedItems: ['Labour', 'Basic supplies'],
      providerMessage: 'Booked in. See you then.',
      estimatedDurationMinutes: plan.durationMinutes,
      sentAt: time.offerSentAt,
    });
    await walkStatus(this.tx, 'requests', requestId, 'matching', [{ to: 'offers_open', at: time.offerSentAt, actorUserId: provider.userId }]);
    await walkStatus(this.tx, 'offers', offerId, 'sent', [
      { to: 'viewed', at: time.offerViewedAt, actorUserId: customer.userId, set: offerDecisionColumns('viewed', time.offerViewedAt) },
      { to: 'accepted', at: time.offerAcceptedAt, actorUserId: customer.userId, set: offerDecisionColumns('accepted', time.offerAcceptedAt) },
    ]);
    await walkStatus(this.tx, 'requests', requestId, 'offers_open', [{ to: 'provider_selected', at: time.offerAcceptedAt, actorUserId: customer.userId }]);

    // Spec 020: the booking, then the request's `provider_selected → booking_created`.
    const booking = await insertPendingBooking(this.tx, {
      setId: this.setId,
      offerId,
      requestId,
      serviceId: catalogService.serviceId,
      customer,
      providerProfileId,
      addressId: this.addresses.get(plan.customerKey)!,
      scheduledAt: plan.scheduledAt,
      durationMinutes: plan.durationMinutes,
      createdAt: plan.bookedAt,
    });
    this.bookingIds[plan.key] = booking.id;
    await walkStatus(this.tx, 'requests', requestId, 'provider_selected', [{ to: 'booking_created', at: plan.bookedAt, actorUserId: customer.userId }]);

    // Spec 021: the payment, from the adapter's own outcome.
    let payment = await recordPayment(this.tx, { bookingId: booking.id, customerUserId: customer.userId, plan: paymentPlan, outcome });

    if (plan.status === 'pending') {
      if (payment.status !== 'requires_action') throw new Error('demo seed: the pending booking expected a requires-action payment');
      return;
    }
    if (plan.status === 'failed') {
      if (payment.status !== 'created') throw new Error('demo seed: the failed booking expected a declined payment');
      // Spec 021's sweep, once the authorization window has passed with no successful payment.
      payment = await failAbandonedPayment(this.tx, payment);
      await walkStatus(this.tx, 'bookings', booking.id, 'pending', [{ to: 'failed', at: time.failedAt, actorUserId: null, actorRole: 'system' }]);
      return;
    }
    if (payment.status !== 'captured') throw new Error(`demo seed: ${plan.key} expected a captured payment`);

    const providerStep = (to: string, at: Date) => ({ to, at, actorUserId: provider.userId, actorRole: 'provider' as const });
    const steps: { to: string; at: Date; actorUserId: string | null; actorRole: 'customer' | 'provider' | 'system' }[] = [
      { to: 'confirmed', at: time.confirmedAt, actorUserId: customer.userId, actorRole: 'customer' },
    ];
    const reach = (status: string) => {
      const order = ['provider_en_route', 'arrived', 'in_progress', 'completed'];
      const lifecycle = ['provider_en_route', 'arrived', 'in_progress', 'completed', 'protected', 'settled', 'disputed'];
      if (!lifecycle.includes(status)) return;
      const target = order.includes(status) ? order.indexOf(status) : order.length - 1;
      const at = [time.enRouteAt, time.arrivedAt, time.startedAt, time.completedAt];
      for (let index = 0; index <= target; index += 1) steps.push(providerStep(order[index]!, at[index]!));
    };
    reach(plan.status);
    await walkStatus(this.tx, 'bookings', booking.id, 'pending', steps);

    if (plan.status === 'protected' || plan.status === 'settled' || plan.status === 'disputed') {
      // Spec 021 AC-5a: the sweep opens the window at the completion instant, then marks the booking protected.
      payment = await openProtection(this.tx, payment, time.completedAt);
      await walkStatus(this.tx, 'bookings', booking.id, 'completed', [{ to: 'protected', at: time.protectedAt, actorUserId: null, actorRole: 'system' }]);
    }
    if (plan.status === 'settled') {
      payment = await moveProtection(this.tx, payment, 'held', 'released');
      await walkStatus(this.tx, 'bookings', booking.id, 'protected', [{ to: 'settled', at: time.settledAt, actorUserId: null, actorRole: 'system' }]);
    }
    if (plan.status === 'disputed') {
      // Spec 031's `openDispute`: the dispute row, the booking to `disputed`, the protection held as disputed.
      const [row] = await queryRows<{ id: string }>(
        this.tx,
        sql`INSERT INTO disputes (booking_id, opened_by_user_id, status, reason, idempotency_key, idempotency_fingerprint, created_at, updated_at)
            VALUES (${booking.id}, ${customer.userId}, 'open', ${'The final result did not match what was agreed in the offer.'},
                    ${`demo:${this.setId}:${randomUUID()}`}, ${idempotencyFingerprint({ bookingId: booking.id })},
                    ${time.disputedAt.toISOString()}::timestamptz, ${time.disputedAt.toISOString()}::timestamptz)
            RETURNING id`,
      );
      this.disputeIds[plan.key] = row!.id;
      await walkStatus(this.tx, 'bookings', booking.id, 'protected', [{ to: 'disputed', at: time.disputedAt, actorUserId: customer.userId, actorRole: 'customer' }]);
      payment = await moveProtection(this.tx, payment, 'held', 'disputed');
    }
    if ((plan.status === 'cancelled' || plan.status === 'refunded') && cancellation) {
      await this.writeCancellation(plan, booking.id, payment, outcome, cancellation, catalogService.serviceId);
    }
  }

  /** Spec 023's `recordCancellation` + spec 022's policy refund, for a confirmed booking the customer cancelled. */
  private async writeCancellation(
    plan: BookingPlan,
    bookingId: string,
    payment: RecordedPayment,
    outcome: AdapterOutcome,
    cancellation: CancellationFigures,
    serviceId: string,
  ): Promise<void> {
    const customer = this.person(plan.customerKey);
    const cancelledAt = plan.cancelledAt!;
    const policy = await ensurePolicyAcceptance(this.tx, {
      bookingId,
      serviceId,
      customerUserId: customer.userId,
      bookingCreatedAt: plan.bookedAt,
      providerOptionKey: null,
    });
    const consequence = computeCancellationConsequence({
      tiers: policy.tiers,
      hoursBefore: cancellation.hoursBefore,
      capturedAmountMinorUnits: plan.priceAmountMinorUnits,
    });
    if (!consequence || consequence.refundAmountMinorUnits !== cancellation.refundAmountMinorUnits) {
      throw new Error(`demo seed: ${plan.key}'s cancellation policy changed between planning and writing`);
    }

    await walkStatus(this.tx, 'bookings', bookingId, 'confirmed', [{ to: 'cancelled', at: cancelledAt, actorUserId: customer.userId, actorRole: 'customer' }]);
    const decisionRef = `cancellation:${bookingId}:${policy.policyVersionId}`;
    await this.tx.execute(sql`
      INSERT INTO booking_cancellations
        (booking_id, policy_version_id, cancelled_by_user_id, cancelled_by_role, reason_code, note,
         tier_min_hours_before, tier_max_hours_before, tier_fee_percent, hours_before_milli,
         captured_amount_minor_units, captured_currency_code, fee_amount_minor_units,
         refund_amount_minor_units, decision_ref, idempotency_key, idempotency_fingerprint, created_at, updated_at)
      VALUES (${bookingId}, ${policy.policyVersionId}, ${customer.userId}, 'customer', NULL, NULL,
              ${consequence.tier.minHoursBefore}, ${consequence.tier.maxHoursBefore}, ${consequence.tier.feePercent},
              ${toHoursBeforeMilli(cancellation.hoursBefore)}, ${plan.priceAmountMinorUnits}, ${demoCurrency()},
              ${consequence.feeAmountMinorUnits}, ${consequence.refundAmountMinorUnits}, ${decisionRef},
              ${`demo:${this.setId}:${randomUUID()}`}, ${idempotencyFingerprint({ bookingId, actorRole: 'customer' })},
              ${cancelledAt.toISOString()}::timestamptz, ${cancelledAt.toISOString()}::timestamptz)
    `);
    this.refundAmounts[plan.key] = { refund: consequence.refundAmountMinorUnits, fee: consequence.feeAmountMinorUnits };

    if (consequence.refundAmountMinorUnits === 0) return;
    const result = outcome.refunds.get(cancellation.refundId);
    if (!result) throw new Error(`demo seed: no refund outcome for ${plan.key}`);
    const refunded = await recordRefund(this.tx, {
      refundId: cancellation.refundId,
      bookingId,
      payment,
      capturedAmountMinorUnits: plan.priceAmountMinorUnits,
      amountMinorUnits: consequence.refundAmountMinorUnits,
      currencyCode: demoCurrency(),
      providerReference: outcome.authorize.providerReference,
      decisionRef,
      reason: 'Cancellation refund under the booking’s cancellation policy.',
      actorUserId: customer.userId,
      result,
    });
    this.refundIds[plan.key] = cancellation.refundId;
    if (refunded.fullyRefunded) {
      // Spec 022's `advancePaymentAndBooking`: a full refund moves the booking on to `refunded`.
      await walkStatus(this.tx, 'bookings', bookingId, 'cancelled', [
        { to: 'refunded', at: new Date(cancelledAt.getTime() + 60_000), actorUserId: null, actorRole: 'system' },
      ]);
    }
    if (plan.status === 'refunded' && !refunded.fullyRefunded) {
      throw new Error(`demo seed: ${plan.key} expected a full refund`);
    }
  }

  /** Spec 029: one review per planned booking, eligibility and signals decided by spec 029's own functions. */
  async writeReviews(): Promise<void> {
    for (const plan of this.plan.bookings) {
      if (!plan.review) continue;
      const customer = this.person(plan.customerKey);
      const bookingId = this.bookingIds[plan.key]!;
      const eligibility = await resolveReviewEligibility(customer.userId, bookingId, this.tx);
      if (!eligibility?.eligible) throw new Error(`demo seed: ${plan.key} is not eligible for a review (${eligibility?.reason})`);
      const { codes } = evaluateReviewSignals(plan.review.text);
      const reviewedAt = new Date(new Date(eligibility.completedAt!).getTime() + 26 * 3_600_000);
      const [row] = await queryRows<{ id: string }>(
        this.tx,
        sql`INSERT INTO reviews (booking_id, author_user_id, provider_profile_id, service_id, rating, text, status,
                                 flag_signals, idempotency_key, idempotency_fingerprint, created_at, updated_at)
            VALUES (${bookingId}, ${customer.userId}, ${eligibility.providerProfileId}, ${eligibility.serviceId},
                    ${plan.review.rating}, ${plan.review.text}, ${codes.length > 0 ? 'flagged' : 'published'},
                    ${JSON.stringify(codes)}::jsonb, ${`demo:${this.setId}:${randomUUID()}`},
                    ${idempotencyFingerprint({ bookingId, rating: plan.review.rating, text: plan.review.text })},
                    ${reviewedAt.toISOString()}::timestamptz, ${reviewedAt.toISOString()}::timestamptz)
            RETURNING id`,
      );
      this.reviewIds[plan.key] = row!.id;
    }
  }

  /** Spec 026 inbox rows, rendered by spec 026's own catalogue, with the event keys its sinks use. No deliveries. */
  async writeNotifications(): Promise<void> {
    for (const plan of this.plan.notifications) {
      const recipient = this.person(plan.recipientKey);
      const { params, eventKey } = this.notificationSubject(plan);
      const rendered = renderNotification(plan.type, params);
      await this.tx.execute(sql`
        INSERT INTO notifications (recipient_user_id, category, type, title, body, params, event_key, read_at, created_at, updated_at)
        VALUES (${recipient.userId}, ${rendered.category}, ${plan.type}, ${rendered.title}, ${rendered.body},
                ${JSON.stringify(params)}::jsonb, ${eventKey},
                ${plan.read ? plan.createdAt.toISOString() : null}::timestamptz,
                ${plan.createdAt.toISOString()}::timestamptz, ${plan.createdAt.toISOString()}::timestamptz)
      `);
    }
  }

  private notificationSubject(plan: SetPlan['notifications'][number]): { params: NotificationParams; eventKey: string } {
    const { subject } = plan;
    if (subject.refundOf) {
      const refundId = this.refundIds[subject.refundOf]!;
      return { params: { refundId, bookingId: this.bookingIds[subject.refundOf]! }, eventKey: `refund_completed:${refundId}` };
    }
    if (subject.reviewOf) {
      const reviewId = this.reviewIds[subject.reviewOf]!;
      return { params: { reviewId }, eventKey: `review_received:${reviewId}` };
    }
    if (subject.disputeOf) {
      const disputeId = this.disputeIds[subject.disputeOf]!;
      return { params: { disputeId, bookingId: this.bookingIds[subject.disputeOf]! }, eventKey: `dispute_opened:${disputeId}` };
    }
    if (subject.requestKey) {
      const requestId = this.requestIds[subject.requestKey]!;
      return { params: { requestId }, eventKey: `request_cancelled:${requestId}` };
    }
    const bookingId = this.bookingIds[subject.bookingKey!]!;
    const amounts = this.refundAmounts[subject.bookingKey!]!;
    return {
      params: {
        bookingId,
        refundAmount: { amountMinorUnits: amounts.refund, currencyCode: demoCurrency() },
        feeAmount: { amountMinorUnits: amounts.fee, currencyCode: demoCurrency() },
      },
      eventKey: `booking_cancelled:${bookingId}`,
    };
  }
}
