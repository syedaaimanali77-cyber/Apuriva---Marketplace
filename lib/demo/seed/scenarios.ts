/**
 * Spec 045 §3.3 — WHAT a demo set contains, as plain data. `provision.ts` writes it.
 *
 * Both sets cover AC-2 on their own:
 *   - the eight 0006 categories' services, referenced, never re-created;
 *   - providers with packages and portfolio placeholders, in each availability state — `available`,
 *     `busy` (a real booking occupies every remaining slot today while they are inside their hours) and
 *     `unavailable` (today is blocked by a date override);
 *   - requests in every customer-visible status the request state machine can reach (`submitted`,
 *     `matching`, `offers_open`, `provider_selected`, `booking_created`, `cancelled` — §3.3: `expired` and
 *     `completed` have no seeded transition, so writing them would be a state the real machine cannot produce);
 *   - offers in every status the offer machine reaches, including expired ones;
 *   - bookings in all twelve spec 020 statuses, each with the payment its status implies;
 *   - reviews and notifications.
 *
 * Every instant is derived from one `now`, so a set is internally consistent whatever time it is provisioned.
 */
import { addDays, utcToZoned, zonedDateTimeToUtc } from '@/lib/availability/timezone';
import { platformCurrencyCode } from '@/lib/config/currency';
import type { BookingStatus } from '@/lib/types/bookings';
import type { NotificationType } from '@/lib/types/notifications';
import type { DemoPersona } from '@/lib/types/demo';
import type { DemoServiceSlug } from './catalog';
import { DEMO_TIMEZONE, type DemoPlace } from './writers';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Spec 042 §3.9: the platform's configured market currency (`PLATFORM_CURRENCY_CODE`), never a literal. */
export const demoCurrency = (): string => platformCurrencyCode();

export type AvailabilityPlan = 'available' | 'busy' | 'unavailable';

export interface PersonPlan {
  key: string;
  name: string;
  businessName?: string;
  place: DemoPlace;
}

export interface ProviderPlan {
  key: string;
  availability: AvailabilityPlan;
  services: { slug: DemoServiceSlug; durationMinutes: number }[];
  packages: { slug: DemoServiceSlug; name: string; description: string; amountMinorUnits: number; includedItems: string[] }[];
  portfolioCount: number;
}

export type SeededOfferStatus = 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'withdrawn';

export interface OfferPlan {
  providerKey: string;
  status: SeededOfferStatus;
  priceAmountMinorUnits: number;
  sentAt: Date;
  /** The decision instant for viewed/accepted/declined/withdrawn (expired needs none). */
  decidedAt?: Date;
}

export type SeededRequestStatus = 'submitted' | 'matching' | 'offers_open' | 'provider_selected' | 'cancelled';

export interface RequestPlan {
  key: string;
  customerKey: string;
  slug: DemoServiceSlug;
  status: SeededRequestStatus;
  description: string;
  createdAt: Date;
  /** Providers the request was distributed to (spec 017), in rank order. */
  matchedProviderKeys: string[];
  offers: OfferPlan[];
  /** For `cancelled`: when the customer cancelled. */
  cancelledAt?: Date;
}

export interface BookingPlan {
  key: string;
  status: BookingStatus;
  customerKey: string;
  providerKey: string;
  slug: DemoServiceSlug;
  priceAmountMinorUnits: number;
  scheduledAt: Date;
  durationMinutes: number;
  bookedAt: Date;
  description: string;
  /** cancelled / refunded: the cancellation instant (the fee tier follows from the hours before). */
  cancelledAt?: Date;
  review?: { rating: number; text: string };
}

export interface NotificationPlan {
  recipientKey: string;
  type: NotificationType;
  /** Resolved against the written rows by the provisioner. */
  subject: { bookingKey?: string; requestKey?: string; refundOf?: string; reviewOf?: string; disputeOf?: string };
  createdAt: Date;
  read: boolean;
}

export interface SetPlan {
  persona: DemoPersona;
  personaKey: string;
  people: PersonPlan[];
  providers: ProviderPlan[];
  requests: RequestPlan[];
  bookings: BookingPlan[];
  notifications: NotificationPlan[];
  /** The local instant (minute of day, 30-minute grid) the busy provider's occupying job starts. */
  busyStartMinute: number;
  today: string;
}

const LAHORE_PLACES: DemoPlace[] = [
  { area: 'Gulberg', city: 'Lahore', latitudeMicroDegrees: 31_520_000, longitudeMicroDegrees: 74_358_000 },
  { area: 'DHA Phase 5', city: 'Lahore', latitudeMicroDegrees: 31_462_000, longitudeMicroDegrees: 74_408_000 },
  { area: 'Johar Town', city: 'Lahore', latitudeMicroDegrees: 31_469_000, longitudeMicroDegrees: 74_272_000 },
  { area: 'Model Town', city: 'Lahore', latitudeMicroDegrees: 31_483_000, longitudeMicroDegrees: 74_326_000 },
  { area: 'Bahria Town', city: 'Lahore', latitudeMicroDegrees: 31_368_000, longitudeMicroDegrees: 74_185_000 },
  { area: 'Cantt', city: 'Lahore', latitudeMicroDegrees: 31_510_000, longitudeMicroDegrees: 74_390_000 },
  { area: 'Wapda Town', city: 'Lahore', latitudeMicroDegrees: 31_436_000, longitudeMicroDegrees: 74_266_000 },
];

/** Shared time helpers for one plan, all relative to the same `now`. */
function clock(now: Date) {
  const local = utcToZoned(now, DEMO_TIMEZONE);
  return {
    today: local.date,
    /** Minute of the current local day, rounded down to spec 016's 30-minute slot grid. */
    busyStartMinute: Math.floor(local.minuteOfDay / 30) * 30,
    ago: (ms: number) => new Date(now.getTime() - ms),
    ahead: (ms: number) => new Date(now.getTime() + ms),
    /** A local wall-clock time `dayOffset` days from today. */
    at: (dayOffset: number, minuteOfDay: number) => zonedDateTimeToUtc(addDays(local.date, dayOffset), minuteOfDay, DEMO_TIMEZONE),
  };
}

const PACKAGES: Record<string, ProviderPlan['packages']> = {
  cleaning: [
    { slug: 'home-cleaning', name: 'Standard clean', description: 'Two bedrooms, kitchen and lounge.', amountMinorUnits: 450_000, includedItems: ['Dusting', 'Mopping', 'Kitchen wipe-down'] },
    { slug: 'home-cleaning', name: 'Deep clean', description: 'Whole home, including bathrooms and windows.', amountMinorUnits: 900_000, includedItems: ['Bathrooms', 'Inside windows', 'Appliance exteriors'] },
  ],
  repair: [
    { slug: 'general-home-repair', name: 'Handyman hour', description: 'One hour of small fixes.', amountMinorUnits: 300_000, includedItems: ['Fixtures', 'Minor leaks', 'Hanging and mounting'] },
    { slug: 'general-home-repair', name: 'Half-day repairs', description: 'Four hours for a list of jobs.', amountMinorUnits: 1_000_000, includedItems: ['Up to four hours', 'Basic materials'] },
  ],
  moving: [
    { slug: 'local-moving', name: 'Small move', description: 'Studio or one-bedroom, within the city.', amountMinorUnits: 800_000, includedItems: ['Two movers', 'Loading and unloading'] },
  ],
  photography: [
    { slug: 'event-photography', name: 'Event coverage', description: 'Four hours of event photography.', amountMinorUnits: 1_200_000, includedItems: ['Edited gallery', '150+ photos'] },
  ],
  grooming: [
    { slug: 'personal-grooming', name: 'At-home grooming', description: 'Haircut and styling at your home.', amountMinorUnits: 250_000, includedItems: ['Haircut', 'Styling'] },
  ],
  car: [
    { slug: 'car-maintenance', name: 'Doorstep service', description: 'Oil change and a 20-point check.', amountMinorUnits: 650_000, includedItems: ['Oil change', '20-point inspection'] },
  ],
  consulting: [
    { slug: 'general-consulting', name: 'One-hour session', description: 'A focused one-hour consultation.', amountMinorUnits: 400_000, includedItems: ['Follow-up notes'] },
  ],
};

/**
 * The status steps a booking walks, each derived from its own schedule. Kept here so every plan states its
 * timeline once and the provisioner never has to guess it.
 */
export function bookingTimeline(plan: BookingPlan) {
  const scheduled = plan.scheduledAt.getTime();
  const completedAt = new Date(scheduled + plan.durationMinutes * MINUTE);
  return {
    confirmedAt: new Date(plan.bookedAt.getTime() + 10_000),
    failedAt: new Date(plan.bookedAt.getTime() + 31 * MINUTE),
    enRouteAt: new Date(scheduled - 30 * MINUTE),
    arrivedAt: new Date(scheduled - 5 * MINUTE),
    startedAt: new Date(scheduled),
    completedAt,
    protectedAt: new Date(completedAt.getTime() + 10 * MINUTE),
    disputedAt: new Date(completedAt.getTime() + 20 * HOUR),
    settledAt: new Date(completedAt.getTime() + 48 * HOUR + 10 * MINUTE),
    // The request's own path to `provider_selected`, ending just before the booking.
    requestCreatedAt: new Date(plan.bookedAt.getTime() - 60 * MINUTE),
    offerSentAt: new Date(plan.bookedAt.getTime() - 4 * MINUTE),
    offerViewedAt: new Date(plan.bookedAt.getTime() - 3 * MINUTE - 40_000),
    offerAcceptedAt: new Date(plan.bookedAt.getTime() - 3 * MINUTE),
  };
}

// ---------------------------------------------------------------------------------------------------
// Customer set (§3.3): the persona customer, four providers (available, busy, unavailable, and a second
// available one with a rich profile) and two customers who wrote the providers' existing reviews.
// ---------------------------------------------------------------------------------------------------

export function customerSetPlan(now: Date): SetPlan {
  const t = clock(now);
  const busyDuration = 1440 - t.busyStartMinute;

  const people: PersonPlan[] = [
    { key: 'me', name: 'Ayesha', place: LAHORE_PLACES[0]! },
    { key: 'reviewerA', name: 'Hamza', place: LAHORE_PLACES[1]! },
    { key: 'reviewerB', name: 'Sana', place: LAHORE_PLACES[2]! },
    { key: 'cleaner', name: 'Bilal', businessName: 'Sparkle Home Cleaning', place: LAHORE_PLACES[3]! },
    { key: 'movers', name: 'Kamran', businessName: 'Swift Movers', place: LAHORE_PLACES[4]! },
    { key: 'photographer', name: 'Nida', businessName: 'Frame & Flash Photography', place: LAHORE_PLACES[5]! },
    { key: 'handyman', name: 'Imran', businessName: 'FixRight Repairs', place: LAHORE_PLACES[6]! },
  ];

  const providers: ProviderPlan[] = [
    { key: 'cleaner', availability: 'available', services: [{ slug: 'home-cleaning', durationMinutes: 120 }], packages: PACKAGES.cleaning!, portfolioCount: 1 },
    { key: 'movers', availability: 'busy', services: [{ slug: 'local-moving', durationMinutes: 180 }], packages: PACKAGES.moving!, portfolioCount: 1 },
    {
      key: 'photographer',
      availability: 'unavailable',
      services: [
        { slug: 'event-photography', durationMinutes: 240 },
        { slug: 'event-planning', durationMinutes: 120 },
      ],
      packages: PACKAGES.photography!,
      portfolioCount: 1,
    },
    {
      key: 'handyman',
      availability: 'available',
      services: [
        { slug: 'general-home-repair', durationMinutes: 60 },
        { slug: 'home-cleaning', durationMinutes: 120 },
        { slug: 'car-maintenance', durationMinutes: 90 },
        { slug: 'general-consulting', durationMinutes: 60 },
      ],
      packages: [...PACKAGES.repair!, ...PACKAGES.car!, ...PACKAGES.consulting!],
      portfolioCount: 3,
    },
  ];

  const bookings: BookingPlan[] = [
    { key: 'pending', status: 'pending', customerKey: 'me', providerKey: 'cleaner', slug: 'home-cleaning', priceAmountMinorUnits: 451_103, scheduledAt: t.at(3, 600), durationMinutes: 120, bookedAt: t.ago(3 * MINUTE), description: 'Weekly clean of a two-bedroom flat.' },
    { key: 'failed', status: 'failed', customerKey: 'me', providerKey: 'handyman', slug: 'general-home-repair', priceAmountMinorUnits: 381_102, scheduledAt: t.at(4, 660), durationMinutes: 60, bookedAt: t.ago(2 * HOUR), description: 'Replace a broken door handle.' },
    { key: 'confirmed', status: 'confirmed', customerKey: 'me', providerKey: 'cleaner', slug: 'home-cleaning', priceAmountMinorUnits: 450_000, scheduledAt: t.at(2, 600), durationMinutes: 120, bookedAt: t.ago(DAY), description: 'Clean before guests arrive.' },
    { key: 'enRoute', status: 'provider_en_route', customerKey: 'me', providerKey: 'handyman', slug: 'general-home-repair', priceAmountMinorUnits: 300_000, scheduledAt: t.ahead(25 * MINUTE), durationMinutes: 60, bookedAt: t.ago(2 * DAY), description: 'Fix a dripping bathroom tap.' },
    { key: 'arrived', status: 'arrived', customerKey: 'me', providerKey: 'cleaner', slug: 'home-cleaning', priceAmountMinorUnits: 450_000, scheduledAt: t.ahead(3 * MINUTE), durationMinutes: 60, bookedAt: t.ago(3 * DAY), description: 'Quick kitchen clean.' },
    { key: 'inProgress', status: 'in_progress', customerKey: 'me', providerKey: 'movers', slug: 'local-moving', priceAmountMinorUnits: 800_000, scheduledAt: t.at(0, t.busyStartMinute), durationMinutes: busyDuration, bookedAt: t.ago(4 * DAY), description: 'Move a one-bedroom flat across town.' },
    { key: 'completed', status: 'completed', customerKey: 'me', providerKey: 'handyman', slug: 'general-home-repair', priceAmountMinorUnits: 350_000, scheduledAt: t.ago(130 * MINUTE), durationMinutes: 120, bookedAt: t.ago(3 * DAY), description: 'Mount a TV and two shelves.' },
    { key: 'protected', status: 'protected', customerKey: 'me', providerKey: 'cleaner', slug: 'home-cleaning', priceAmountMinorUnits: 450_000, scheduledAt: t.at(-1, 600), durationMinutes: 120, bookedAt: t.ago(4 * DAY), description: 'Regular fortnightly clean.' },
    { key: 'settled', status: 'settled', customerKey: 'me', providerKey: 'cleaner', slug: 'home-cleaning', priceAmountMinorUnits: 900_000, scheduledAt: t.at(-5, 600), durationMinutes: 180, bookedAt: t.ago(8 * DAY), description: 'Deep clean after renovation.', review: { rating: 5, text: 'Spotless work and on time. Will book again.' } },
    { key: 'cancelled', status: 'cancelled', customerKey: 'me', providerKey: 'handyman', slug: 'general-home-repair', priceAmountMinorUnits: 600_000, scheduledAt: t.ahead(12 * HOUR), durationMinutes: 60, bookedAt: t.ago(2 * DAY), cancelledAt: t.ago(6 * HOUR), description: 'Install a ceiling fan.' },
    { key: 'disputed', status: 'disputed', customerKey: 'me', providerKey: 'photographer', slug: 'event-photography', priceAmountMinorUnits: 1_200_000, scheduledAt: t.at(-2, 600), durationMinutes: 240, bookedAt: t.ago(7 * DAY), description: 'Photograph a family birthday party.' },
    { key: 'refunded', status: 'refunded', customerKey: 'me', providerKey: 'movers', slug: 'local-moving', priceAmountMinorUnits: 520_000, scheduledAt: t.ahead(2 * DAY), durationMinutes: 180, bookedAt: t.ago(3 * DAY), cancelledAt: t.ago(DAY), description: 'Move furniture to a storage unit.' },
    // The two reviewers' own completed jobs, behind the providers' existing reviews.
    { key: 'reviewA1', status: 'settled', customerKey: 'reviewerA', providerKey: 'handyman', slug: 'general-home-repair', priceAmountMinorUnits: 300_000, scheduledAt: t.at(-6, 600), durationMinutes: 60, bookedAt: t.ago(9 * DAY), description: 'Fix a leaking kitchen tap.', review: { rating: 5, text: 'Fixed our leaking kitchen tap quickly and left everything tidy.' } },
    { key: 'reviewA2', status: 'settled', customerKey: 'reviewerA', providerKey: 'movers', slug: 'local-moving', priceAmountMinorUnits: 800_000, scheduledAt: t.at(-8, 540), durationMinutes: 180, bookedAt: t.ago(11 * DAY), description: 'Move a sofa and a bed.', review: { rating: 4, text: 'Careful with the furniture, arrived a little late.' } },
    { key: 'reviewB1', status: 'settled', customerKey: 'reviewerB', providerKey: 'photographer', slug: 'event-photography', priceAmountMinorUnits: 1_200_000, scheduledAt: t.at(-7, 900), durationMinutes: 240, bookedAt: t.ago(12 * DAY), description: 'Cover an engagement dinner.', review: { rating: 5, text: 'Beautiful photos, delivered within two days.' } },
    { key: 'reviewB2', status: 'settled', customerKey: 'reviewerB', providerKey: 'cleaner', slug: 'home-cleaning', priceAmountMinorUnits: 450_000, scheduledAt: t.at(-9, 600), durationMinutes: 120, bookedAt: t.ago(12 * DAY), description: 'Move-out clean.', review: { rating: 4, text: 'Thorough and friendly. Missed one window.' } },
  ];

  const requests: RequestPlan[] = [
    { key: 'submitted', customerKey: 'me', slug: 'general-consulting', status: 'submitted', description: 'Advice on setting up a small home office.', createdAt: t.ago(5 * MINUTE), matchedProviderKeys: [], offers: [] },
    { key: 'matching', customerKey: 'me', slug: 'event-planning', status: 'matching', description: 'Plan a small anniversary dinner for 20 guests.', createdAt: t.ago(20 * MINUTE), matchedProviderKeys: ['photographer'], offers: [] },
    {
      key: 'offersCompare',
      customerKey: 'me',
      slug: 'home-cleaning',
      status: 'offers_open',
      description: 'Clean a three-bedroom house this weekend.',
      createdAt: t.ago(HOUR),
      matchedProviderKeys: ['cleaner', 'handyman'],
      offers: [
        { providerKey: 'cleaner', status: 'expired', priceAmountMinorUnits: 520_000, sentAt: t.ago(30 * MINUTE) },
        { providerKey: 'handyman', status: 'declined', priceAmountMinorUnits: 700_000, sentAt: t.ago(25 * MINUTE), decidedAt: t.ago(24 * MINUTE) },
        { providerKey: 'cleaner', status: 'sent', priceAmountMinorUnits: 480_000, sentAt: t.ago(40_000) },
      ],
    },
    {
      key: 'offersViewed',
      customerKey: 'me',
      slug: 'general-consulting',
      status: 'offers_open',
      description: 'A one-hour budgeting session.',
      createdAt: t.ago(45 * MINUTE),
      matchedProviderKeys: ['handyman'],
      offers: [
        { providerKey: 'handyman', status: 'withdrawn', priceAmountMinorUnits: 450_000, sentAt: t.ago(20 * MINUTE), decidedAt: t.ago(19 * MINUTE) },
        { providerKey: 'handyman', status: 'viewed', priceAmountMinorUnits: 400_000, sentAt: t.ago(70_000), decidedAt: t.ago(50_000) },
      ],
    },
    {
      key: 'selected',
      customerKey: 'me',
      slug: 'car-maintenance',
      status: 'provider_selected',
      description: 'Oil change and a general check at home.',
      createdAt: t.ago(40 * MINUTE),
      matchedProviderKeys: ['handyman'],
      offers: [{ providerKey: 'handyman', status: 'accepted', priceAmountMinorUnits: 650_000, sentAt: t.ago(18 * MINUTE), decidedAt: t.ago(15 * MINUTE) }],
    },
    { key: 'cancelledRequest', customerKey: 'me', slug: 'personal-grooming', status: 'cancelled', description: 'A haircut at home before an event.', createdAt: t.ago(2 * DAY + HOUR), matchedProviderKeys: [], offers: [], cancelledAt: t.ago(2 * DAY) },
  ];

  const notifications: NotificationPlan[] = [
    { recipientKey: 'me', type: 'booking_cancelled', subject: { bookingKey: 'cancelled' }, createdAt: t.ago(6 * HOUR), read: false },
    { recipientKey: 'me', type: 'refund_completed', subject: { refundOf: 'cancelled' }, createdAt: t.ago(6 * HOUR - MINUTE), read: false },
    { recipientKey: 'me', type: 'refund_completed', subject: { refundOf: 'refunded' }, createdAt: t.ago(DAY - MINUTE), read: true },
    { recipientKey: 'photographer', type: 'dispute_opened', subject: { disputeOf: 'disputed' }, createdAt: t.ago(DAY), read: false },
    { recipientKey: 'cleaner', type: 'review_received', subject: { reviewOf: 'settled' }, createdAt: t.ago(3 * DAY), read: true },
  ];

  return { persona: 'customer', personaKey: 'me', people, providers, requests, bookings, notifications, busyStartMinute: t.busyStartMinute, today: t.today };
}

// ---------------------------------------------------------------------------------------------------
// Provider set (§3.3): the persona provider (available), three customers whose requests and bookings
// involve the persona, and a busy and an unavailable provider for comparison.
// ---------------------------------------------------------------------------------------------------

export function providerSetPlan(now: Date): SetPlan {
  const t = clock(now);
  const busyDuration = 1440 - t.busyStartMinute;

  const people: PersonPlan[] = [
    { key: 'me', name: 'Bilal', businessName: 'Sparkle Home Cleaning', place: LAHORE_PLACES[0]! },
    { key: 'customerA', name: 'Hamza', place: LAHORE_PLACES[1]! },
    { key: 'customerB', name: 'Sana', place: LAHORE_PLACES[2]! },
    { key: 'customerC', name: 'Usman', place: LAHORE_PLACES[3]! },
    { key: 'movers', name: 'Kamran', businessName: 'Swift Movers', place: LAHORE_PLACES[4]! },
    { key: 'stylist', name: 'Mariam', businessName: 'Glow Beauty Studio', place: LAHORE_PLACES[5]! },
  ];

  const providers: ProviderPlan[] = [
    {
      key: 'me',
      availability: 'available',
      services: [
        { slug: 'home-cleaning', durationMinutes: 120 },
        { slug: 'general-home-repair', durationMinutes: 60 },
      ],
      packages: [...PACKAGES.cleaning!, ...PACKAGES.repair!],
      portfolioCount: 3,
    },
    { key: 'movers', availability: 'busy', services: [{ slug: 'local-moving', durationMinutes: 180 }], packages: PACKAGES.moving!, portfolioCount: 1 },
    { key: 'stylist', availability: 'unavailable', services: [{ slug: 'personal-grooming', durationMinutes: 60 }], packages: PACKAGES.grooming!, portfolioCount: 1 },
  ];

  const bookings: BookingPlan[] = [
    { key: 'pending', status: 'pending', customerKey: 'customerA', providerKey: 'me', slug: 'home-cleaning', priceAmountMinorUnits: 451_103, scheduledAt: t.at(3, 600), durationMinutes: 120, bookedAt: t.ago(3 * MINUTE), description: 'Weekly clean of a two-bedroom flat.' },
    { key: 'failed', status: 'failed', customerKey: 'customerB', providerKey: 'me', slug: 'general-home-repair', priceAmountMinorUnits: 381_102, scheduledAt: t.at(4, 660), durationMinutes: 60, bookedAt: t.ago(2 * HOUR), description: 'Replace a broken door handle.' },
    { key: 'confirmed', status: 'confirmed', customerKey: 'customerC', providerKey: 'me', slug: 'home-cleaning', priceAmountMinorUnits: 450_000, scheduledAt: t.at(2, 600), durationMinutes: 120, bookedAt: t.ago(DAY), description: 'Clean before guests arrive.' },
    { key: 'enRoute', status: 'provider_en_route', customerKey: 'customerA', providerKey: 'me', slug: 'general-home-repair', priceAmountMinorUnits: 300_000, scheduledAt: t.ahead(25 * MINUTE), durationMinutes: 60, bookedAt: t.ago(2 * DAY), description: 'Fix a dripping bathroom tap.' },
    { key: 'arrived', status: 'arrived', customerKey: 'customerB', providerKey: 'movers', slug: 'local-moving', priceAmountMinorUnits: 800_000, scheduledAt: t.at(0, t.busyStartMinute), durationMinutes: busyDuration, bookedAt: t.ago(4 * DAY), description: 'Move a one-bedroom flat across town.' },
    { key: 'inProgress', status: 'in_progress', customerKey: 'customerC', providerKey: 'me', slug: 'home-cleaning', priceAmountMinorUnits: 450_000, scheduledAt: t.ago(50 * MINUTE), durationMinutes: 70, bookedAt: t.ago(3 * DAY), description: 'Quick kitchen clean.' },
    { key: 'completed', status: 'completed', customerKey: 'customerB', providerKey: 'me', slug: 'home-cleaning', priceAmountMinorUnits: 450_000, scheduledAt: t.ago(200 * MINUTE), durationMinutes: 120, bookedAt: t.ago(3 * DAY), description: 'Clean a small office.' },
    { key: 'protected', status: 'protected', customerKey: 'customerA', providerKey: 'me', slug: 'home-cleaning', priceAmountMinorUnits: 450_000, scheduledAt: t.at(-1, 600), durationMinutes: 120, bookedAt: t.ago(4 * DAY), description: 'Regular fortnightly clean.' },
    { key: 'settled', status: 'settled', customerKey: 'customerC', providerKey: 'me', slug: 'general-home-repair', priceAmountMinorUnits: 1_000_000, scheduledAt: t.at(-5, 600), durationMinutes: 240, bookedAt: t.ago(8 * DAY), description: 'A half-day list of small repairs.', review: { rating: 5, text: 'Sorted every job on our list in one visit.' } },
    { key: 'cancelled', status: 'cancelled', customerKey: 'customerB', providerKey: 'me', slug: 'home-cleaning', priceAmountMinorUnits: 600_000, scheduledAt: t.ahead(12 * HOUR), durationMinutes: 120, bookedAt: t.ago(2 * DAY), cancelledAt: t.ago(6 * HOUR), description: 'Deep clean of a kitchen.' },
    { key: 'disputed', status: 'disputed', customerKey: 'customerA', providerKey: 'me', slug: 'general-home-repair', priceAmountMinorUnits: 1_000_000, scheduledAt: t.at(-2, 600), durationMinutes: 180, bookedAt: t.ago(7 * DAY), description: 'Repair two cupboard doors and a hinge.' },
    { key: 'refunded', status: 'refunded', customerKey: 'customerC', providerKey: 'me', slug: 'home-cleaning', priceAmountMinorUnits: 520_000, scheduledAt: t.ahead(2 * DAY), durationMinutes: 120, bookedAt: t.ago(3 * DAY), cancelledAt: t.ago(DAY), description: 'Clean a rental before handover.' },
    // Completed jobs behind the persona's existing reviews, and the comparison stylist's.
    { key: 'reviewA', status: 'settled', customerKey: 'customerA', providerKey: 'me', slug: 'home-cleaning', priceAmountMinorUnits: 450_000, scheduledAt: t.at(-6, 600), durationMinutes: 120, bookedAt: t.ago(9 * DAY), description: 'Move-out clean.', review: { rating: 4, text: 'Thorough and friendly. Missed one window.' } },
    { key: 'reviewB', status: 'settled', customerKey: 'customerB', providerKey: 'me', slug: 'general-home-repair', priceAmountMinorUnits: 300_000, scheduledAt: t.at(-8, 600), durationMinutes: 60, bookedAt: t.ago(11 * DAY), description: 'Fix a leaking kitchen tap.', review: { rating: 5, text: 'Fixed our leaking kitchen tap quickly and left everything tidy.' } },
    { key: 'reviewStylist', status: 'settled', customerKey: 'customerA', providerKey: 'stylist', slug: 'personal-grooming', priceAmountMinorUnits: 250_000, scheduledAt: t.at(-7, 960), durationMinutes: 60, bookedAt: t.ago(10 * DAY), description: 'Haircut at home.', review: { rating: 5, text: 'Great haircut, very professional.' } },
  ];

  const requests: RequestPlan[] = [
    { key: 'submitted', customerKey: 'customerA', slug: 'personal-grooming', status: 'submitted', description: 'A haircut at home this evening.', createdAt: t.ago(5 * MINUTE), matchedProviderKeys: [], offers: [] },
    { key: 'matching', customerKey: 'customerB', slug: 'home-cleaning', status: 'matching', description: 'Clean a three-bedroom house this weekend.', createdAt: t.ago(10 * MINUTE), matchedProviderKeys: ['me'], offers: [] },
    {
      key: 'offerLive',
      customerKey: 'customerC',
      slug: 'home-cleaning',
      status: 'offers_open',
      description: 'Clean a studio flat tomorrow morning.',
      createdAt: t.ago(HOUR),
      matchedProviderKeys: ['me'],
      offers: [
        { providerKey: 'me', status: 'expired', priceAmountMinorUnits: 380_000, sentAt: t.ago(40 * MINUTE) },
        { providerKey: 'me', status: 'sent', priceAmountMinorUnits: 350_000, sentAt: t.ago(30_000) },
      ],
    },
    {
      key: 'offerViewed',
      customerKey: 'customerA',
      slug: 'general-home-repair',
      status: 'offers_open',
      description: 'Fix a sticking front door.',
      createdAt: t.ago(45 * MINUTE),
      matchedProviderKeys: ['me'],
      offers: [
        { providerKey: 'me', status: 'withdrawn', priceAmountMinorUnits: 350_000, sentAt: t.ago(30 * MINUTE), decidedAt: t.ago(29 * MINUTE) },
        { providerKey: 'me', status: 'viewed', priceAmountMinorUnits: 300_000, sentAt: t.ago(60_000), decidedAt: t.ago(40_000) },
      ],
    },
    {
      key: 'selected',
      customerKey: 'customerB',
      slug: 'general-home-repair',
      status: 'provider_selected',
      description: 'Mount two shelves in the lounge.',
      createdAt: t.ago(40 * MINUTE),
      matchedProviderKeys: ['me'],
      offers: [{ providerKey: 'me', status: 'accepted', priceAmountMinorUnits: 300_000, sentAt: t.ago(18 * MINUTE), decidedAt: t.ago(15 * MINUTE) }],
    },
    {
      key: 'cancelledRequest',
      customerKey: 'customerC',
      slug: 'home-cleaning',
      status: 'cancelled',
      description: 'Clean an apartment before a party.',
      createdAt: t.ago(DAY + 2 * HOUR),
      matchedProviderKeys: ['me'],
      offers: [{ providerKey: 'me', status: 'declined', priceAmountMinorUnits: 500_000, sentAt: t.ago(DAY + HOUR), decidedAt: t.ago(DAY + HOUR - MINUTE) }],
      cancelledAt: t.ago(DAY),
    },
  ];

  const notifications: NotificationPlan[] = [
    { recipientKey: 'me', type: 'review_received', subject: { reviewOf: 'settled' }, createdAt: t.ago(2 * DAY), read: false },
    { recipientKey: 'me', type: 'review_received', subject: { reviewOf: 'reviewA' }, createdAt: t.ago(4 * DAY), read: true },
    { recipientKey: 'me', type: 'booking_cancelled', subject: { bookingKey: 'cancelled' }, createdAt: t.ago(6 * HOUR), read: false },
    { recipientKey: 'me', type: 'dispute_opened', subject: { disputeOf: 'disputed' }, createdAt: t.ago(DAY), read: false },
    { recipientKey: 'me', type: 'request_cancelled', subject: { requestKey: 'cancelledRequest' }, createdAt: t.ago(DAY), read: true },
  ];

  return { persona: 'provider', personaKey: 'me', people, providers, requests, bookings, notifications, busyStartMinute: t.busyStartMinute, today: t.today };
}

export function setPlanFor(persona: DemoPersona, now: Date): SetPlan {
  return persona === 'customer' ? customerSetPlan(now) : providerSetPlan(now);
}
