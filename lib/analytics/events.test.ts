import { describe, expect, it } from 'vitest';
import { ANALYTICS_EVENT_TYPES } from '@/lib/types/analytics';
import { EVENT_PROPERTY_RULES, isAnalyticsEventType, validateAnalyticsEvent, type AnalyticsEventInput } from './events';
import { providerPerformanceCsv, PROVIDER_PERFORMANCE_CSV_COLUMNS } from './csv';

const USER = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

/** One valid event per type — the exact §3.4 shape. */
const VALID: Record<(typeof ANALYTICS_EVENT_TYPES)[number], AnalyticsEventInput> = {
  search_performed: {
    type: 'search_performed',
    actorUserId: null,
    properties: { serviceId: A, categoryId: B, hasQuery: true, hasLocation: false, resultCount: 0 },
  },
  request_submitted: { type: 'request_submitted', actorUserId: USER, properties: { requestId: A, serviceId: B } },
  offer_accepted: { type: 'offer_accepted', actorUserId: USER, properties: { offerId: A, requestId: B } },
  booking_completed: { type: 'booking_completed', actorUserId: USER, properties: { bookingId: A, actingAs: 'provider' } },
  review_submitted: { type: 'review_submitted', actorUserId: USER, properties: { reviewId: A, bookingId: B, rating: 5 } },
  ai_conversation_started: { type: 'ai_conversation_started', actorUserId: USER, properties: { conversationId: A } },
};

describe('analytics event vocabulary (spec 040 §3.4, AC-1/AC-3)', () => {
  it('has exactly the six tracked actions, each with a property allow-list', () => {
    expect([...ANALYTICS_EVENT_TYPES].sort()).toEqual(Object.keys(EVENT_PROPERTY_RULES).sort());
    expect(ANALYTICS_EVENT_TYPES).toHaveLength(6);
  });

  it('accepts one valid event of every type', () => {
    for (const event of Object.values(VALID)) expect(validateAnalyticsEvent(event)).toBeNull();
  });

  it('accepts a search without the optional service/category ids', () => {
    expect(
      validateAnalyticsEvent({ type: 'search_performed', actorUserId: USER, properties: { hasQuery: false, hasLocation: true, resultCount: 12 } }),
    ).toBeNull();
    expect(
      validateAnalyticsEvent({
        type: 'search_performed',
        actorUserId: null,
        properties: { serviceId: undefined, categoryId: undefined, hasQuery: false, hasLocation: false, resultCount: 3 },
      }),
    ).toBeNull();
  });

  it('rejects any key outside the allow-list — search text, names and contact data can never ride along', () => {
    for (const leak of ['q', 'query', 'searchText', 'name', 'email', 'phone', 'score']) {
      const event = { ...VALID.search_performed, properties: { ...VALID.search_performed.properties, [leak]: 'x' } };
      expect(validateAnalyticsEvent(event)).toMatch(/not allowed/);
    }
    expect(
      validateAnalyticsEvent({ ...VALID.review_submitted, properties: { ...VALID.review_submitted.properties, body: 'Great!' } }),
    ).toMatch(/not allowed/);
  });

  it('rejects a missing required key and a wrongly typed value', () => {
    expect(validateAnalyticsEvent({ ...VALID.request_submitted, properties: { requestId: A } })).toMatch(/required/);
    expect(validateAnalyticsEvent({ ...VALID.offer_accepted, properties: { offerId: 'nope', requestId: B } })).toMatch(/invalid value/);
    expect(validateAnalyticsEvent({ ...VALID.booking_completed, properties: { bookingId: A, actingAs: 'admin' } })).toMatch(/invalid value/);
    for (const rating of [0, 6, 4.5, '5']) {
      expect(validateAnalyticsEvent({ ...VALID.review_submitted, properties: { reviewId: A, bookingId: B, rating } })).toMatch(/invalid value/);
    }
    for (const resultCount of [-1, 1.5, '3']) {
      expect(
        validateAnalyticsEvent({ ...VALID.search_performed, properties: { hasQuery: true, hasLocation: true, resultCount } }),
      ).toMatch(/invalid value/);
    }
    expect(
      validateAnalyticsEvent({ ...VALID.search_performed, properties: { hasQuery: 'yes', hasLocation: true, resultCount: 1 } }),
    ).toMatch(/invalid value/);
  });

  it('rejects an unknown type, a bad actor, anonymity outside search, and non-object properties', () => {
    expect(validateAnalyticsEvent({ ...VALID.search_performed, type: 'page_view' as never })).toBe('unknown event type');
    expect(validateAnalyticsEvent({ ...VALID.request_submitted, actorUserId: 'not-a-uuid' })).toMatch(/actorUserId/);
    expect(validateAnalyticsEvent({ ...VALID.request_submitted, actorUserId: null })).toMatch(/anonymous/);
    expect(validateAnalyticsEvent({ ...VALID.request_submitted, properties: [] as never })).toMatch(/object/);
    expect(validateAnalyticsEvent({ ...VALID.request_submitted, properties: null as never })).toMatch(/object/);
    expect(validateAnalyticsEvent(null as never)).toMatch(/not an object/);
  });

  it('isAnalyticsEventType is a closed guard', () => {
    expect(isAnalyticsEventType('offer_accepted')).toBe(true);
    expect(isAnalyticsEventType('OFFER_ACCEPTED')).toBe(false);
    expect(isAnalyticsEventType(3)).toBe(false);
  });
});

describe('provider performance CSV (spec 040 §5)', () => {
  it('has exactly the aggregate DTO columns, with null as empty', () => {
    const csv = providerPerformanceCsv([
      {
        providerProfileId: A,
        notifications: 4,
        exposureShare: 0.5,
        responseTimeMinutes: null,
        completionRate: 1,
        averageRating: 4.5,
        ratingCount: 2,
      },
    ]);
    const [header, row] = csv.split('\n');
    expect(header).toBe(PROVIDER_PERFORMANCE_CSV_COLUMNS.join(','));
    expect(header).not.toMatch(/name|email|phone|score/i);
    expect(row).toBe(`${A},4,0.5,,1,4.5,2`);
    expect(providerPerformanceCsv([])).toBe(header);
  });
});
