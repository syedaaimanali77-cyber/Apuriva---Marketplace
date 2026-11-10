import { describe, expect, it } from 'vitest';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_TYPES } from '@/lib/types/notifications';
import { NOTIFICATION_CATALOGUE, NotificationTemplateError, isNotificationType, renderNotification } from './catalogue';

/** Spec 026 AC-4 — the closed catalogue. */
describe('notification catalogue (spec 026 AC-4)', () => {
  it('every type maps to exactly one category', () => {
    expect(Object.keys(NOTIFICATION_CATALOGUE).sort()).toEqual([...NOTIFICATION_TYPES].sort());
    for (const type of NOTIFICATION_TYPES) {
      expect(NOTIFICATION_CATEGORIES).toContain(NOTIFICATION_CATALOGUE[type].category);
    }
  });

  it('every category has at least one type, so every §57 category is reachable', () => {
    const used = new Set(NOTIFICATION_TYPES.map((type) => NOTIFICATION_CATALOGUE[type].category));
    expect([...used].sort()).toEqual([...NOTIFICATION_CATEGORIES].sort());
  });

  it('every template renders with its declared params and leaves no placeholder unsubstituted', () => {
    for (const type of NOTIFICATION_TYPES) {
      const params = Object.fromEntries(NOTIFICATION_CATALOGUE[type].params.map((name) => [name, `value-${name}`]));
      const rendered = renderNotification(type, params);
      expect(rendered.title).not.toMatch(/\{[a-zA-Z0-9_]+\}/);
      expect(rendered.body).not.toMatch(/\{[a-zA-Z0-9_]+\}/);
      expect(rendered.title.length).toBeGreaterThan(0);
      expect(rendered.body.length).toBeGreaterThan(0);
      // Every declared param is actually used by a template.
      for (const name of NOTIFICATION_CATALOGUE[type].params) {
        expect(`${rendered.title} ${rendered.body}`).toContain(`value-${name}`);
      }
    }
  });

  it('refuses an unknown type or a missing declared param', () => {
    expect(isNotificationType('promotion')).toBe(true);
    expect(isNotificationType('toString')).toBe(false);
    expect(() => renderNotification('nope' as never)).toThrow(NotificationTemplateError);
    expect(() => renderNotification('booking_cancelled', { refundAmount: 'PKR 1' })).toThrow(/feeAmount/);
  });

  it('criticality is by category — the no-show response deadline is operational, refunds are payments', () => {
    expect(NOTIFICATION_CATALOGUE.no_show_response_requested.category).toBe('operational');
    expect(NOTIFICATION_CATALOGUE.refund_completed.category).toBe('payments');
    expect(NOTIFICATION_CATALOGUE.security_alert.category).toBe('security');
    expect(NOTIFICATION_CATALOGUE.message_received.category).toBe('messages');
    expect(NOTIFICATION_CATALOGUE.promotion.category).toBe('promotions');
  });
});
