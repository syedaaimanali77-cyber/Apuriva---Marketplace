/**
 * Spec 040 §3.4 (AC-1, AC-3) — the closed event vocabulary and each type's EXACT property allow-list.
 *
 * `properties` holds ids, enums, booleans and counts only: never free text, names, contact data or
 * search text. An event with an unknown type, a missing required key, an extra key or a wrongly
 * typed value is rejected — never partially recorded.
 */
import { isUuid } from '@/lib/offers/validation';
import { ANALYTICS_EVENT_TYPES, type AnalyticsEventType } from '@/lib/types/analytics';

type Rule = { required: boolean; check: (value: unknown) => boolean };

const uuid = (required = true): Rule => ({ required, check: (v) => typeof v === 'string' && isUuid(v) });
const bool = (): Rule => ({ required: true, check: (v) => typeof v === 'boolean' });
const count = (): Rule => ({ required: true, check: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 });
const oneOf = (...values: string[]): Rule => ({ required: true, check: (v) => typeof v === 'string' && values.includes(v) });
const rating = (): Rule => ({ required: true, check: (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5 });

export const EVENT_PROPERTY_RULES: Readonly<Record<AnalyticsEventType, Readonly<Record<string, Rule>>>> = {
  search_performed: {
    serviceId: uuid(false),
    categoryId: uuid(false),
    hasQuery: bool(),
    hasLocation: bool(),
    resultCount: count(),
  },
  request_submitted: { requestId: uuid(), serviceId: uuid() },
  offer_accepted: { offerId: uuid(), requestId: uuid() },
  booking_completed: { bookingId: uuid(), actingAs: oneOf('customer', 'provider') },
  review_submitted: { reviewId: uuid(), bookingId: uuid(), rating: rating() },
  ai_conversation_started: { conversationId: uuid() },
};

export interface AnalyticsEventInput {
  type: AnalyticsEventType;
  /** The acting user; `null` for a guest (only `search_performed` may be anonymous). */
  actorUserId: string | null;
  properties: Record<string, unknown>;
}

export function isAnalyticsEventType(value: unknown): value is AnalyticsEventType {
  return typeof value === 'string' && (ANALYTICS_EVENT_TYPES as readonly string[]).includes(value);
}

/** Why an event is invalid, or `null` when it may be recorded. */
export function validateAnalyticsEvent(input: AnalyticsEventInput): string | null {
  if (!input || typeof input !== 'object') return 'event is not an object';
  if (!isAnalyticsEventType(input.type)) return 'unknown event type';
  if (input.actorUserId !== null && !(typeof input.actorUserId === 'string' && isUuid(input.actorUserId))) {
    return 'actorUserId must be a uuid or null';
  }
  if (input.actorUserId === null && input.type !== 'search_performed') return 'only a search may be anonymous';
  const properties = input.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return 'properties must be an object';

  const rules = EVENT_PROPERTY_RULES[input.type];
  for (const key of Object.keys(properties)) {
    if (!(key in rules)) return `property "${key}" is not allowed for ${input.type}`;
  }
  for (const [key, rule] of Object.entries(rules)) {
    const value = properties[key];
    if (value === undefined || value === null) {
      if (rule.required) return `property "${key}" is required for ${input.type}`;
      continue;
    }
    if (!rule.check(value)) return `property "${key}" has an invalid value`;
  }
  return null;
}
