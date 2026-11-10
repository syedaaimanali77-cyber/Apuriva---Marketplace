import { describe, expect, it } from 'vitest';
import { CRITICAL_CATEGORIES, NOTIFICATION_CATEGORIES } from '@/lib/types/notifications';
import { NOTIFICATION_DEFAULTS, defaultCategoryChannelMap } from './defaults';
import {
  isFloorChannel,
  normalizeCategoryChannelMap,
  promotionsAllowed,
  resolveOutboundChannels,
  validateCategoryChannelMap,
} from './preferences';

/** Spec 026 §3 "Preference resolution" (AC-1, AC-2, AC-3) — pure resolution and write-time validation. */
describe('notification preference resolution (spec 026)', () => {
  it('defaults: email on only for non-overridable categories; push and sms off everywhere', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      const critical = (CRITICAL_CATEGORIES as readonly string[]).includes(category);
      expect(NOTIFICATION_DEFAULTS[category]).toEqual({ email: critical, push: false, sms: false });
      expect(resolveOutboundChannels(category, null)).toEqual(critical ? ['email'] : []);
    }
  });

  it('an overridable category follows the stored map exactly, in push → email → sms order', () => {
    const map = defaultCategoryChannelMap();
    map.booking = { email: true, push: true, sms: false };
    expect(resolveOutboundChannels('booking', map)).toEqual(['push', 'email']);
    map.booking = { email: false, push: false, sms: false };
    expect(resolveOutboundChannels('booking', map)).toEqual([]);
  });

  it('a stored false on a non-overridable floor channel is ignored; extra channels are honoured', () => {
    const map = defaultCategoryChannelMap();
    map.security = { email: false, push: false, sms: true };
    expect(resolveOutboundChannels('security', map)).toEqual(['email', 'sms']);
    for (const category of CRITICAL_CATEGORIES) expect(isFloorChannel(category, 'email')).toBe(true);
    expect(isFloorChannel('booking', 'email')).toBe(false);
    expect(isFloorChannel('payments', 'push')).toBe(false);
  });

  it('promotions require consent AND an enabled promotions channel', () => {
    const map = defaultCategoryChannelMap();
    expect(promotionsAllowed(null)).toEqual({ allowed: false, reason: 'no_consent' });
    expect(promotionsAllowed({ categories: map, marketingConsentAt: null, version: 1 })).toEqual({ allowed: false, reason: 'no_consent' });
    expect(promotionsAllowed({ categories: map, marketingConsentAt: new Date(), version: 1 })).toEqual({
      allowed: false,
      reason: 'preference_disabled',
    });
    map.promotions.email = true;
    expect(promotionsAllowed({ categories: map, marketingConsentAt: null, version: 1 })).toEqual({ allowed: false, reason: 'no_consent' });
    expect(promotionsAllowed({ categories: map, marketingConsentAt: new Date(), version: 1 })).toEqual({ allowed: true });
  });

  it('validation rejects unknown categories and channels, in_app, non-booleans and malformed shapes', () => {
    expect(validateCategoryChannelMap({ booking: { email: true } }, { partial: true })).toEqual([]);
    expect(validateCategoryChannelMap('nope', { partial: true })).toEqual([{ field: 'categories', message: 'must be an object' }]);
    expect(validateCategoryChannelMap([], { partial: true })).toHaveLength(1);
    const fields = (input: unknown) => validateCategoryChannelMap(input, { partial: true }).map((e) => e.field);
    expect(fields({ marketing: { email: true } })).toEqual(['categories.marketing']);
    expect(fields({ booking: { fax: true } })).toEqual(['categories.booking.fax']);
    expect(fields({ booking: { in_app: false } })).toEqual(['categories.booking.in_app']);
    expect(fields({ booking: { email: 'yes' } })).toEqual(['categories.booking.email']);
    expect(fields({ booking: true })).toEqual(['categories.booking']);
  });

  it('full-map validation requires every category and channel', () => {
    expect(validateCategoryChannelMap(defaultCategoryChannelMap(), { partial: false })).toEqual([]);
    const partial = { booking: { email: true, push: false } };
    const errors = validateCategoryChannelMap(partial, { partial: false }).map((e) => e.field);
    expect(errors).toContain('categories.booking.sms');
    expect(errors).toContain('categories.security');
  });

  it('normalizes a malformed stored map back to defaults field by field', () => {
    const normalized = normalizeCategoryChannelMap({ booking: { email: true, push: 'x' }, security: null });
    expect(normalized.booking).toEqual({ email: true, push: false, sms: false });
    expect(normalized.security).toEqual(NOTIFICATION_DEFAULTS.security);
    expect(normalizeCategoryChannelMap(null)).toEqual(defaultCategoryChannelMap());
  });
});
