import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 022 — a SOURCE-LEVEL guard, the idiom specs 020 and 021 established, so the boundaries this
 * spec claims cannot rot as it grows.
 *
 * The invariants asserted here are exactly the ownership rules §3 and §7 state:
 *   - `lib/refunds/**` applies NO cancellation-policy rule of its own (spec 023 owns those);
 *   - it writes no `payouts` row and never sets `reconciliation_state = 'reconciled'` (spec 024);
 *   - it implements no dispute or approval logic of its own (specs 031 / 009);
 *   - it never writes `bookings.status` or `payments.status` with its own SQL (specs 020 / 021);
 *   - it makes no provider call inside a database transaction;
 *   - no provider handle or failure code crosses the DTO boundary.
 */
const ROOT = join(__dirname, '..', '..');
const REFUNDS_DIR = join(ROOT, 'lib', 'refunds');
const PROVIDER_DIR = join(ROOT, 'lib', 'payments', 'provider');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function isProduction(file: string): boolean {
  return !/\.test\.tsx?$/.test(file) && !/test-support\.ts$/.test(file);
}

/**
 * These assertions are about CODE, not prose. Every module documents the boundary it respects, so
 * matching raw file text would make a correct file fail for describing its own correctness.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The text between a callback's opening brace and its matching close. */
function transactionBody(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return source.slice(openIndex);
}

const REFUND_FILES = sourceFiles(REFUNDS_DIR).filter(isProduction);

describe('spec 022 — ownership boundaries', () => {
  it('has production sources to check', () => {
    expect(REFUND_FILES.length).toBeGreaterThan(6);
  });

  /**
   * AC-1 — spec 023 owns cancellation policy. This spec executes a decision it is HANDED; if it
   * ever started computing one, these literals would appear.
   */
  it('lib/refunds applies no cancellation rule of its own', () => {
    const offenders: string[] = [];
    for (const file of REFUND_FILES) {
      const source = code(file);
      if (/free[_ ]?window|cancellationPolicy|cancellation_policy|noShowFee|no_show_fee/i.test(source)) {
        offenders.push(`${file}: encodes a cancellation-policy concept`);
      }
      if (/hoursBefore|hours_before|cancelledWithin/i.test(source)) offenders.push(`${file}: computes a policy window`);
    }
    expect(offenders).toEqual([]);
  });

  /** AC-4 — spec 024 owns the ledger. This spec produces only the reconciliation FACT. */
  it('writes no payouts row and never marks a refund reconciled', () => {
    const offenders: string[] = [];
    for (const file of REFUND_FILES) {
      const source = code(file);
      if (/INSERT INTO\s+"?payouts/i.test(source) || /UPDATE\s+"?payouts/i.test(source)) {
        offenders.push(`${file}: writes a payouts row`);
      }
      if (/payoutMethods|payout_methods|earningsLedger/i.test(source)) offenders.push(`${file}: touches payout data`);
      // `reconciled` is spec 024's only write into this table.
      if (/reconciliation_state\s*=\s*'reconciled'/.test(source) || /reconciliationState:\s*'reconciled'/.test(source)) {
        offenders.push(`${file}: marks a refund reconciled`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /** §7 — disputes are spec 031's; this spec knows nothing about them. */
  it('implements no dispute logic', () => {
    const offenders = REFUND_FILES.filter((file) => /INSERT INTO\s+"?disputes/i.test(code(file)));
    expect(offenders).toEqual([]);
  });

  /**
   * AC-3 — spec 009 owns approval. This spec must not re-implement the four-eyes rule: a second
   * implementation is a second place for it to be wrong.
   */
  it('implements no approval logic of its own', () => {
    const offenders: string[] = [];
    for (const file of REFUND_FILES) {
      const source = code(file);
      if (/UPDATE\s+admin_actions/i.test(source)) offenders.push(`${file}: writes admin_actions directly`);
      if (/INSERT INTO\s+"?admin_action_approvals/i.test(source)) offenders.push(`${file}: writes an approval row`);
    }
    expect(offenders).toEqual([]);
  });

  /** §3 — booking and payment status are written ONLY through their owning spec's primitive. */
  it('never writes bookings.status or payments.status with its own SQL', () => {
    const offenders: string[] = [];
    for (const file of REFUND_FILES) {
      const source = code(file);
      if (/UPDATE\s+bookings[\s\S]{0,200}SET[\s\S]{0,200}\bstatus\s*=/i.test(source)) {
        offenders.push(`${file}: writes bookings.status directly`);
      }
      if (/UPDATE\s+payments[\s\S]{0,200}SET[\s\S]{0,200}\bstatus\s*=/i.test(source)) {
        offenders.push(`${file}: writes payments.status directly`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * §3 "Transaction and lock ordering" — a network round trip while a payment row lock is held
   * would block every other writer on that payment for the duration of the provider's latency.
   */
  it('makes no provider call inside a database transaction', () => {
    const offenders: string[] = [];
    for (const file of REFUND_FILES) {
      const source = code(file);
      for (const match of source.matchAll(/transaction\(async \(tx\) => \{/g)) {
        const body = transactionBody(source, (match.index ?? 0) + match[0].length - 1);
        if (/\bprovider\.(refund|getRefundStatus|authorize|capture)\(/.test(body)) {
          offenders.push(`${file}: calls the provider inside a transaction`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * AC-7 — the sweep resolves ambiguity with a READ. If it ever issued `provider.refund()`, a
   * repeated sweep could refund twice.
   */
  it('never issues a provider refund from the reconcile sweep', () => {
    const sweep = code(join(REFUNDS_DIR, 'sweep.ts'));
    expect(sweep).toMatch(/getRefundStatus/);
    expect(sweep).not.toMatch(/provider\.refund\(/);
  });

  /** §4 "Retention and privacy" — provider handles and failure codes never reach a DTO. */
  it('never exposes a provider reference or failure code through the refund DTO', () => {
    const types = code(join(ROOT, 'lib', 'types', 'refunds.ts'));
    expect(types).not.toMatch(/providerReference/);
    expect(types).not.toMatch(/refundReference/);
    expect(types).not.toMatch(/failureCode/);
    expect(types).not.toMatch(/idempotencyKey/);

    // The read projection selects an explicit column list that omits them.
    const read = code(join(REFUNDS_DIR, 'read.ts'));
    expect(read).not.toMatch(/REFUND_DTO_COLUMNS[\s\S]{0,400}provider_reference/);
    expect(read).not.toMatch(/REFUND_DTO_COLUMNS[\s\S]{0,400}failure_code/);
    expect(read).not.toMatch(/REFUND_DTO_COLUMNS[\s\S]{0,400}idempotency_key/);
  });

  /** §3 — one payment abstraction. Refunds reach the vendor only through spec 021's adapter. */
  it('reads no payment credential and imports no vendor SDK', () => {
    const offenders: string[] = [];
    for (const file of REFUND_FILES) {
      const source = code(file);
      if (/process\.env\.PAYMENT_[A-Z0-9_]*(KEY|SECRET|TOKEN|CREDENTIAL)/.test(source)) {
        offenders.push(`${file}: reads a payment credential`);
      }
      if (/from '(stripe|@stripe\/|braintree|paypal|razorpay|adyen|easypaisa|jazzcash)/i.test(source)) {
        offenders.push(`${file}: imports a payment vendor SDK`);
      }
    }
    expect(offenders).toEqual([]);
    // And the adapter directory is still the only place a refund primitive is implemented.
    expect(sourceFiles(PROVIDER_DIR).filter(isProduction).length).toBeGreaterThan(0);
  });

  /**
   * AC-7 — the single most important branch in the codebase: an `unknown` outcome must never be
   * recorded as `failed`. Asserted structurally so a refactor cannot quietly collapse them.
   */
  it('never maps an unknown provider outcome onto failed', () => {
    const execute = code(join(REFUNDS_DIR, 'execute.ts'));
    expect(execute).not.toMatch(/outcome\s*===\s*'unknown'[\s\S]{0,300}to:\s*'failed'/);
    // The unknown branch exists and returns without transitioning.
    expect(execute).toMatch(/outcome\s*===\s*'unknown'/);
  });
});
