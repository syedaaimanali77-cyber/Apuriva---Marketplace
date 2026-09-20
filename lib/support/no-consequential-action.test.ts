/**
 * Spec 032 §6 "Consequential-action boundary" (AC-9) — asserted at SOURCE LEVEL.
 *
 * The shape of spec 022's `no-policy-leak.test.ts` and spec 031's `no-money-leak.test.ts`, and it
 * exists for the same reason: "support owns the conversation, not the consequence" is only true if
 * the code physically cannot do the consequential thing. A behavioural test proves the current
 * paths behave; this proves no path exists — including one a future edit might add — because the
 * forbidden constructs are absent from the directory altogether.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SUPPORT_DIR = join(__dirname);

function sourceFiles(): { name: string; body: string }[] {
  return readdirSync(SUPPORT_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('test-support.ts'))
    .map((name) => ({ name, body: readFileSync(join(SUPPORT_DIR, name), 'utf8') }));
}

/** Strips block and line comments, so the prose explaining a prohibition never trips it. */
function code(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('lib/support contains no consequential action', () => {
  const files = sourceFiles();

  it('has source files to check (guards against a silently empty assertion)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('writes no refunds, payouts or payments row', () => {
    for (const { name, body } of files) {
      const src = code(body);
      expect(src, `${name} must not write refunds`).not.toMatch(/INSERT\s+INTO\s+refunds|UPDATE\s+refunds/i);
      expect(src, `${name} must not write payouts`).not.toMatch(/INSERT\s+INTO\s+payouts|UPDATE\s+payouts/i);
      expect(src, `${name} must not write payments`).not.toMatch(/INSERT\s+INTO\s+payments|UPDATE\s+payments/i);
    }
  });

  it('writes no dispute resolution and no dispute row at all', () => {
    for (const { name, body } of files) {
      const src = code(body);
      expect(src, `${name} must not write dispute_resolutions`).not.toMatch(/INSERT\s+INTO\s+dispute_resolutions|UPDATE\s+dispute_resolutions/i);
      expect(src, `${name} must not create a dispute`).not.toMatch(/INSERT\s+INTO\s+disputes/i);
      expect(src, `${name} must not update a dispute`).not.toMatch(/UPDATE\s+disputes/i);
    }
  });

  it('never writes a users lifecycle status — no sanction, no ban, no restriction', () => {
    for (const { name, body } of files) {
      const src = code(body);
      expect(src, `${name} must not write users`).not.toMatch(/UPDATE\s+users/i);
      expect(src, `${name} must not touch lifecycle_status`).not.toMatch(/lifecycle_status/);
    }
  });

  it('imports no payment, refund, payout or moderation primitive', () => {
    const forbidden = [
      'setProtectionState',
      'applyBookingTransition',
      'registerBookingTransitions',
      'registerRefundEligibilityGate',
      'registerPayoutHoldGate',
      'registerSafetyRestrictionGate',
      'authorizeAndInitiate',
      'evaluateEligibility',
    ];
    for (const { name, body } of files) {
      const src = code(body);
      for (const symbol of forbidden) {
        expect(src, `${name} must not use ${symbol}`).not.toContain(symbol);
      }
    }
  });

  it('never calls a payment provider', () => {
    for (const { name, body } of files) {
      const src = code(body);
      expect(src, `${name} must not reach a provider adapter`).not.toMatch(/lib\/payments\/provider|paymentProvider|chargeProvider/);
    }
  });

  it('touches spec 030 only through its own creation path, and never its outcome', () => {
    const src = files.map((f) => code(f.body)).join('\n');
    // The single permitted door.
    expect(src).toContain('createSafetyReport');
    // Never the deciding half of spec 030.
    for (const symbol of ['resolveSafetyReport', 'escalateSafetyReport', 'claimSafetyReport', 'setSafetyPriority']) {
      expect(src, `must not call ${symbol}`).not.toContain(symbol);
    }
    expect(src).not.toMatch(/UPDATE\s+safety_reports/i);
  });
});
