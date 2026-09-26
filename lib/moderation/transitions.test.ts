import { describe, expect, it } from 'vitest';
import { isLifecycleType, severityOf } from './catalogue';
import { STANDING_SEVERITY } from './standing';

/** Spec 038 §3.4 — severity ordering and the "strictly more severe" supersede rule, as pure data. */
describe('lifecycle severity (spec 038 §3.4)', () => {
  it('orders restricted < suspended < banned, above good', () => {
    expect(STANDING_SEVERITY.good).toBeLessThan(STANDING_SEVERITY.restricted);
    expect(STANDING_SEVERITY.restricted).toBeLessThan(STANDING_SEVERITY.suspended);
    expect(STANDING_SEVERITY.suspended).toBeLessThan(STANDING_SEVERITY.banned);
  });

  it('matches action severity to the standing each action sets', () => {
    expect(severityOf('restriction')).toBe(STANDING_SEVERITY.restricted);
    expect(severityOf('suspension')).toBe(STANDING_SEVERITY.suspended);
    expect(severityOf('ban')).toBe(STANDING_SEVERITY.banned);
  });

  it('non-lifecycle types have no severity, so they never supersede or conflict with a sanction', () => {
    for (const type of ['warning', 'booking_intervention', 'payout_freeze'] as const) {
      expect(isLifecycleType(type)).toBe(false);
      expect(severityOf(type)).toBe(0);
    }
  });

  it('a new sanction may supersede only a strictly less severe one', () => {
    const mayReplace = (next: 'restriction' | 'suspension' | 'ban', current: 'restriction' | 'suspension' | 'ban') =>
      severityOf(next) > severityOf(current);
    expect(mayReplace('suspension', 'restriction')).toBe(true);
    expect(mayReplace('ban', 'suspension')).toBe(true);
    expect(mayReplace('restriction', 'restriction')).toBe(false);
    expect(mayReplace('restriction', 'ban')).toBe(false);
  });
});
