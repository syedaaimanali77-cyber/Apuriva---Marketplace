import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 023 §6 "Source guard" — the ownership boundaries, asserted at source level so they cannot rot.
 *
 * Every rule here restates something the spec promises about what this domain does NOT do. A comment
 * saying "spec 022 owns refund execution" is worth nothing six months from now; a failing test is.
 */
const CANCELLATION_DIR = join(process.cwd(), 'lib', 'cancellation');
const NO_SHOW_DIR = join(process.cwd(), 'lib', 'no-show');

function sourceFiles(dir: string): Array<{ path: string; source: string }> {
  const results: Array<{ path: string; source: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
    // Test files and fixtures legitimately reach across boundaries to SET UP a scenario.
    if (entry.includes('.test.') || entry.includes('test-support')) continue;
    results.push({ path: full, source: readFileSync(full, 'utf8') });
  }
  return results;
}

const DOMAIN_FILES = [...sourceFiles(CANCELLATION_DIR), ...sourceFiles(NO_SHOW_DIR)];

function offenders(pattern: RegExp): string[] {
  return DOMAIN_FILES.filter(({ source }) => pattern.test(source)).map(({ path }) => path);
}

describe('spec 023 ownership boundaries (source-level)', () => {
  /**
   * Spec 020 owns `bookings.status`. `applyBookingTransition` is the one writer, and using it is
   * what keeps the transition graph, the history row and the database trigger in agreement.
   */
  it('never writes bookings.status with its own SQL', () => {
    expect(offenders(/UPDATE\s+bookings\s+SET[^`]*\bstatus\s*=/i)).toEqual([]);
  });

  /** AC-7: spec 022 executes refunds. This spec decides, and never touches the money tables. */
  it('writes no refunds, refund_lines, payments or payouts row', () => {
    expect(offenders(/INSERT\s+INTO\s+"?(refunds|refund_lines|payments|payment_authorizations|payouts)"?/i)).toEqual([]);
    expect(offenders(/UPDATE\s+"?(refunds|refund_lines|payments|payment_authorizations|payouts)"?\s+SET/i)).toEqual([]);
  });

  /** Spec 021 is the only spec that may reach a payment provider. */
  it('imports no payment-provider module and resolves no adapter', () => {
    expect(offenders(/from\s+'@\/lib\/payments\/provider/)).toEqual([]);
    expect(offenders(/resolvePaymentProvider/)).toEqual([]);
  });

  /**
   * AC-6: spec 017 owns ranking. This spec supplies a count through a read function, so the
   * dependency direction is 017 → 023 and this domain cannot develop an opinion about weights.
   */
  it('imports nothing from lib/matching', () => {
    expect(offenders(/from\s+'@\/lib\/matching/)).toEqual([]);
  });

  /** AC-6 / master spec §132.11: no automatic ban, suspension or account restriction. */
  it('writes no user or provider lifecycle status', () => {
    expect(offenders(/UPDATE\s+"?(users|provider_profiles|customer_profiles)"?\s+SET[^`]*\b(lifecycle_status|status)\s*=/i)).toEqual([]);
    expect(offenders(/\b(suspend|ban|deactivate)[A-Za-z]*\s*\(/)).toEqual([]);
  });

  /**
   * AC-10 / §3 "Evidence model": no device location is ever collected or stored. The absence of a
   * coordinate column is the real guarantee; this catches an attempt to add one back through code.
   */
  it('stores no coordinates on a no-show report', () => {
    expect(offenders(/no_show_reports[^`]*\b(latitude|longitude|coordinates|gps)\b/i)).toEqual([]);
  });

  /**
   * The ONE place a fee percentage may be written down is the seeded platform default. A literal
   * anywhere else would be a policy decision hiding in code rather than in configuration data.
   */
  it('hard-codes no fee percentage outside the seeded platform default', () => {
    const allowed = join(CANCELLATION_DIR, 'policy-config.ts');
    const found = DOMAIN_FILES.filter(({ path, source }) => path !== allowed && /feePercent:\s*\d+/.test(source));
    expect(found.map((f) => f.path)).toEqual([]);
  });
});

describe('spec 022 boundary stays intact (cross-spec)', () => {
  /** Spec 022's own guard: no cancellation rule may migrate INTO the refund domain. */
  it('leaves lib/refunds free of cancellation policy', () => {
    const refundFiles = sourceFiles(join(process.cwd(), 'lib', 'refunds'));
    const leaked = refundFiles.filter(({ source }) =>
      /hoursBefore|feePercent|cancellation_tier|selectTier/.test(source),
    );
    expect(leaked.map((f) => f.path)).toEqual([]);
  });

  /** Spec 020's payment boundary: `lib/bookings/**` still reads no payment or cancellation state. */
  it('leaves lib/bookings importing nothing of this spec', () => {
    const bookingFiles = sourceFiles(join(process.cwd(), 'lib', 'bookings'));
    const leaked = bookingFiles.filter(({ source }) => /@\/lib\/(cancellation|no-show)/.test(source));
    expect(leaked.map((f) => f.path)).toEqual([]);
  });
});
