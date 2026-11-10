import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAYOUT_STATUSES, type PayoutStatus } from '@/lib/types/payouts';
import { isAllowedPayoutTransition, isTerminalPayoutStatus, PAYOUT_TRANSITIONS } from './state-machine';

const EXPECTED = new Set(['pending->eligible', 'eligible->processing', 'processing->paid', 'processing->failed', 'failed->eligible']);

/** Spec 024 §3.5 — the payout transition matrix (AC-12). */
describe('payout state machine (spec 024 §3.5)', () => {
  it('exactly the five seeded transitions are legal, over every ordered status pair', () => {
    for (const from of PAYOUT_STATUSES) {
      for (const to of PAYOUT_STATUSES) {
        expect(isAllowedPayoutTransition(from as PayoutStatus, to as PayoutStatus)).toBe(EXPECTED.has(`${from}->${to}`));
      }
    }
    expect(PAYOUT_TRANSITIONS).toHaveLength(5);
  });

  it('paid is terminal and nothing leaves it', () => {
    expect(isTerminalPayoutStatus('paid')).toBe(true);
    for (const to of PAYOUT_STATUSES) expect(isAllowedPayoutTransition('paid', to as PayoutStatus)).toBe(false);
  });

  it('nothing can fail before the rail has been asked, and processing never rewinds', () => {
    expect(isAllowedPayoutTransition('pending', 'failed')).toBe(false);
    expect(isAllowedPayoutTransition('eligible', 'failed')).toBe(false);
    expect(isAllowedPayoutTransition('processing', 'eligible')).toBe(false);
  });

  it('the migration seeds exactly the same five pairs', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'drizzle', '0020_add_provider_payouts_earnings.sql'), 'utf8');
    const block = sql.slice(sql.indexOf('INSERT INTO "payouts_status_transitions"'), sql.indexOf('ON CONFLICT ("from_status", "to_status")'));
    const seeded = [...block.matchAll(/\('(\w+)', '(\w+)'\)/g)].map((m) => `${m[1]}->${m[2]}`);
    expect(new Set(seeded)).toEqual(EXPECTED);
  });

  it('the earnings-line trigger permits only forward moves plus the unattached eligible → pending detach', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'drizzle', '0020_add_provider_payouts_earnings.sql'), 'utf8');
    expect(sql).toContain("(OLD.state = 'pending' AND NEW.state = 'eligible')");
    expect(sql).toContain("(OLD.state = 'eligible' AND NEW.state = 'paid')");
    expect(sql).toMatch(/OLD\.state = 'eligible' AND NEW\.state = 'pending'\s+AND NOT EXISTS/);
  });
});
