import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODERATION_ACTION_TYPES } from '@/lib/db/schema';
import { APPEALABLE, LIFECYCLE_STANDING_FOR, PERMISSION_ACTION_FOR, REQUIRES_APPROVAL, REVERSIBLE } from './catalogue';

/** Spec 038 §3.3 / §3.9 — the catalogue as data, and its agreement with migration 0033's seed. */
const UP = readFileSync(join(__dirname, '..', '..', 'drizzle', '0033_add_admin_moderation_fraud.sql'), 'utf8');

function seededTier(action: string): string | undefined {
  return new RegExp(`\\('moderation', '${action}', '(low|medium|high|critical)'\\)`).exec(UP)?.[1];
}

describe('moderation action catalogue (spec 038 §3.3/§3.9)', () => {
  it('maps every action type to exactly one spec 009 permission action', () => {
    for (const type of MODERATION_ACTION_TYPES) expect(PERMISSION_ACTION_FOR[type]).toBeTruthy();
    expect(PERMISSION_ACTION_FOR).toEqual({
      warning: 'warn',
      restriction: 'restrict',
      suspension: 'suspend',
      ban: 'ban',
      booking_intervention: 'intervene_booking',
      payout_freeze: 'freeze_payout',
    });
  });

  it('AC-2: every four-eyes type is seeded high or critical, and every immediate type low/medium', () => {
    for (const type of MODERATION_ACTION_TYPES) {
      const tier = seededTier(PERMISSION_ACTION_FOR[type]);
      if (REQUIRES_APPROVAL.has(type)) expect(['high', 'critical']).toContain(tier);
      else expect(['low', 'medium']).toContain(tier);
    }
    expect(seededTier('ban')).toBe('critical');
    expect(seededTier('reverse')).toBe('high');
  });

  it('only restriction, suspension and ban set a standing', () => {
    expect(LIFECYCLE_STANDING_FOR).toEqual({ restriction: 'restricted', suspension: 'suspended', ban: 'banned' });
  });

  it('a booking intervention is one-shot: neither appealable nor reversible', () => {
    expect(APPEALABLE.has('booking_intervention')).toBe(false);
    expect(REVERSIBLE.has('booking_intervention')).toBe(false);
    for (const type of ['warning', 'restriction', 'suspension', 'ban', 'payout_freeze'] as const) {
      expect(APPEALABLE.has(type)).toBe(true);
      expect(REVERSIBLE.has(type)).toBe(true);
    }
  });
});
