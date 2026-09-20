/**
 * Spec 031 §6 "Boundary (source-level)" — AC-5 and AC-2, enforced by reading this spec's own source.
 *
 * WHY A SOURCE-LEVEL TEST. §3 "Financial ownership" is stated as a list of prohibitions, and a
 * prohibition is only real if something checks it. A behavioural test can show that today's code
 * does not create a refund; only this can show that no code in `lib/disputes/**` is ABLE to. It is
 * the same device spec 022 uses in `no-policy-leak.test.ts` and spec 030 in `boundary.test.ts`.
 *
 * If a future change genuinely needs one of these, the right response is to change the spec first —
 * not to loosen this file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DISPUTES_DIR = join(__dirname);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    // The spec's own source only: test files and fixtures are allowed to mention anything.
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry.includes('test-support')) continue;
    out.push(full);
  }
  return out;
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** Strips block and line comments, so the prose in this spec's headers cannot fail its own test. */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const FILES = sourceFiles(DISPUTES_DIR);

describe('lib/disputes never moves money itself (spec 031 AC-5, DECIDED-5)', () => {
  it('has source files to check, so the test cannot pass vacuously', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it('never inserts into refunds or payouts', () => {
    const offenders = FILES.filter((file) => /INSERT\s+INTO\s+"?(refunds|payouts)"?/i.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it('never updates a refunds, payouts or payment-money column', () => {
    const offenders = FILES.filter((file) => {
      const source = code(file);
      return (
        /UPDATE\s+"?refunds"?\s+SET/i.test(source) ||
        /UPDATE\s+"?payouts"?\s+SET/i.test(source) ||
        // `payments SET status` is spec 021's/022's alone. This spec touches protection_state only,
        // and then only through spec 021's own `setProtectionState` primitive.
        /UPDATE\s+"?payments"?\s+SET[\s\S]{0,120}?\bstatus\s*=/i.test(source)
      );
    });
    expect(offenders).toEqual([]);
  });

  it('never calls a payment provider', () => {
    const offenders = FILES.filter((file) =>
      /resolvePaymentProvider|getSandboxPaymentProvider|provider\.refund\(|provider\.capture\(|provider\.authorize\(/.test(
        code(file),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('never registers the refund-eligibility gate — that slot is spec 023, and it is single-valued', () => {
    const offenders = FILES.filter((file) => /registerRefundEligibilityGate/.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it('never registers a payout hold gate — that slot is spec 038', () => {
    const offenders = FILES.filter((file) => /registerPayoutHoldGate/.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it('never initiates a spec 009 approval of its own (DECIDED-2: every permission is low/medium)', () => {
    const offenders = FILES.filter((file) => /authorizeAndInitiate|executeApprovedAction|executeApprovedRefund/.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it('reads the refundable position from spec 022 rather than computing one', () => {
    const resolve = code(join(DISPUTES_DIR, 'resolve.ts'));
    // It must USE spec 022's figure...
    expect(resolve).toMatch(/readRefundablePosition/);
    expect(resolve).toMatch(/fitsWithinRemaining/);
    // ...and must not do money arithmetic of its own.
    expect(resolve).not.toMatch(/capturedAmountMinorUnits\s*[-+*/]/);
    expect(resolve).not.toMatch(/remainingRefundableMinorUnits\s*[-+*/]/);
  });

  it('never writes an account lifecycle status — enforcement is spec 038, not this spec', () => {
    const offenders = FILES.filter((file) => /lifecycle_status|lifecycleStatus/.test(code(file)));
    expect(offenders).toEqual([]);
  });

  it('never inserts into safety_reports directly — escalation goes through spec 030 own path', () => {
    const offenders = FILES.filter((file) => /INSERT\s+INTO\s+"?safety_reports"?/i.test(code(file)));
    expect(offenders).toEqual([]);
    // And the one file that escalates must do so by calling spec 030.
    expect(code(join(DISPUTES_DIR, 'escalate.ts'))).toMatch(/createSafetyReport/);
  });

  it('writes bookings.status only through spec 020 primitive, never with a raw UPDATE', () => {
    const offenders = FILES.filter((file) => /UPDATE\s+"?bookings"?\s+SET/i.test(code(file)));
    expect(offenders).toEqual([]);

    for (const file of [join(DISPUTES_DIR, 'create.ts'), join(DISPUTES_DIR, 'close.ts')]) {
      expect(code(file)).toMatch(/applyBookingTransition/);
    }
  });

  it('changes protection state only through spec 021 own version-guarded primitive', () => {
    for (const file of FILES) {
      const source = code(file);
      if (!/protection_state/i.test(source)) continue;
      // A file may READ protection_state; only create.ts and close.ts may change it, and only
      // via setProtectionState.
      if (/UPDATE\s+"?payments"?\s+SET[\s\S]{0,120}?protection_state/i.test(source)) {
        throw new Error(`${file} writes payments.protection_state directly`);
      }
    }
    expect(code(join(DISPUTES_DIR, 'create.ts'))).toMatch(/setProtectionState/);
    expect(code(join(DISPUTES_DIR, 'close.ts'))).toMatch(/setProtectionState/);
  });

  it('stores an approval-chain id, never a refund id, on a resolution', () => {
    const schema = readFileSync(join(__dirname, '..', 'db', 'schema.ts'), 'utf8');
    const block = schema.slice(schema.indexOf('export const disputeResolutions'), schema.indexOf('export const disputeAppeals'));
    expect(block).toMatch(/refund_admin_action_id/);
    // A `refunds.id` foreign key here would be the draft's mistake: no refund row exists at
    // proposal time, and spec 022 creates none until a second admin approves.
    expect(block).not.toMatch(/references\(\(\)\s*=>\s*refunds\./);
  });
});
