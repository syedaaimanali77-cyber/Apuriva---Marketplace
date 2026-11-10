import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Spec 021 §3 "AI and MCP boundary" / "Payment-provider architecture" — a SOURCE-LEVEL guard, the
 * idiom spec 020's `payment-boundary.test.ts` established, so these invariants cannot rot as the
 * spec grows.
 *
 * The invariants asserted here are exactly the ones master spec §132.7 and §133.5 require:
 *   - no module outside `lib/payments/provider/` imports a vendor SDK or reads a payment secret;
 *   - no module outside `lib/payments/record.ts` writes `authorized` or `captured`;
 *   - `lib/ai/**` contains no payment status literal at all (AC-8);
 *   - no offer or request route reaches `lib/payments` (AC-2);
 *   - this spec writes no `payouts` row (AC-5 — spec 024 owns payout execution entirely);
 *   - `PaymentDto` never carries a provider reference (§4 "Retention and privacy").
 */
const ROOT = join(__dirname, '..', '..');
const PAYMENTS_DIR = join(ROOT, 'lib', 'payments');
const PROVIDER_DIR = join(PAYMENTS_DIR, 'provider');
const AI_DIR = join(ROOT, 'lib', 'ai');
const OFFER_ROUTES = join(ROOT, 'app', 'api', 'v1', 'offers');
const REQUEST_ROUTES = join(ROOT, 'app', 'api', 'v1', 'requests');

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
 * These assertions are about CODE, not prose. Every module in this spec documents the boundary it
 * respects — `read.ts`'s header says in so many words that it never returns `provider_reference` —
 * so matching raw file text would make a correct file fail for describing its own correctness.
 * Comments are stripped first, and only the remaining code is searched.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PAYMENT_FILES = sourceFiles(PAYMENTS_DIR).filter(isProduction);
const NON_PROVIDER_PAYMENT_FILES = PAYMENT_FILES.filter((file) => !file.startsWith(PROVIDER_DIR));

describe('spec 021 — no fabricated payment success', () => {
  it('has production sources to check', () => {
    expect(PAYMENT_FILES.length).toBeGreaterThan(8);
    expect(NON_PROVIDER_PAYMENT_FILES.length).toBeGreaterThan(5);
  });

  /**
   * §3 — `lib/payments/provider/` is the ONLY directory permitted to hold provider credentials.
   * A vendor SDK import or a `PAYMENT_*` secret read anywhere else would put credentials in a
   * module that has no business holding them.
   */
  it('reads no payment secret and imports no vendor SDK outside lib/payments/provider', () => {
    const offenders: string[] = [];
    for (const file of NON_PROVIDER_PAYMENT_FILES) {
      const source = code(file);
      // `PAYMENT_PROVIDER` is the adapter NAME, read only by the factory; a *_KEY/_SECRET/_TOKEN is
      // a credential and must never be read outside the provider directory.
      if (/process\.env\.PAYMENT_[A-Z0-9_]*(KEY|SECRET|TOKEN|CREDENTIAL)/.test(source)) {
        offenders.push(`${file}: reads a payment credential`);
      }
      if (/from '(stripe|@stripe\/|braintree|paypal|razorpay|adyen|easypaisa|jazzcash)/i.test(source)) {
        offenders.push(`${file}: imports a payment vendor SDK`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never reads a payment credential anywhere in app/ either', () => {
    const offenders = sourceFiles(join(ROOT, 'app'))
      .filter(isProduction)
      .filter((file) => /process\.env\.PAYMENT_[A-Z0-9_]*(KEY|SECRET|TOKEN|CREDENTIAL)/.test(code(file)));
    expect(offenders).toEqual([]);
  });

  /**
   * AC-1's structural half. Every write that reaches a successful payment status lives in
   * `record.ts`, and every function there takes a `ProviderResult` — so there is no code path to a
   * successful payment that did not come from an adapter response.
   */
  it('writes authorized or captured only in record.ts', () => {
    const offenders: string[] = [];
    for (const file of PAYMENT_FILES) {
      if (file === join(PAYMENTS_DIR, 'record.ts')) continue;
      if (file.startsWith(PROVIDER_DIR)) continue; // the adapters REPORT outcomes; they write no row.
      const source = code(file);
      if (/to:\s*'(authorized|captured)'/.test(source)) offenders.push(`${file}: transitions to a success status`);
      // A WRITE, not a read: `SET status = 'captured'`. Reading `WHERE p.status = 'captured'` to
      // FIND already-successful payments (as the sweep does) is exactly what a reader should do.
      if (/\bSET\b[\s\S]{0,200}?\bstatus\s*=\s*'(authorized|captured)'/i.test(source)) {
        offenders.push(`${file}: assigns a success status`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /** `record.ts` itself must never be able to claim success without an adapter result in hand. */
  it('takes a ProviderResult on every success-recording function', () => {
    const source = code(join(PAYMENTS_DIR, 'record.ts'));
    expect(source).toMatch(/recordAuthorization/);
    expect(source).toMatch(/recordCapture/);
    // Both refuse outright if handed anything but a real success outcome.
    expect(source).toMatch(/recordAuthorization requires an authorized\/captured provider result/);
    expect(source).toMatch(/recordCapture requires a captured provider result/);
  });

  /**
   * AC-8 — spec 033's assistant does not exist yet, so the guarantee is enforced where it can be:
   * nothing under `lib/ai/**` names a payment status, so no AI code can synthesize one today, and
   * a future spec adding such a literal breaks this test rather than shipping quietly.
   */
  it('keeps lib/ai free of payment status literals', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(AI_DIR).filter(isProduction)) {
      const source = code(file);
      if (/'(authorized|captured|requires_action)'/.test(source)) offenders.push(`${file}: names a payment status`);
      if (/payments?\b/i.test(source) && /status/i.test(source)) offenders.push(`${file}: reports payment status`);
    }
    expect(offenders).toEqual([]);
  });

  /** §4 "Retention and privacy" — the provider handle never crosses the DTO boundary. */
  it('never exposes a provider reference through the payment DTO', () => {
    expect(code(join(ROOT, 'lib', 'types', 'payments.ts'))).not.toMatch(/providerReference/);
    const read = code(join(PAYMENTS_DIR, 'read.ts'));
    // The DTO projection selects an explicit column list; `provider_reference` is not in it.
    expect(read).not.toMatch(/PAYMENT_DTO_COLUMNS[\s\S]{0,400}provider_reference/);
  });

  /**
   * AC-2 — authorization happens at the booking's payment step and never at offer acceptance, so
   * no offer or request route may reach this domain at all.
   */
  it('is unreachable from any offer or request route', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(OFFER_ROUTES), ...sourceFiles(REQUEST_ROUTES)].filter(isProduction)) {
      if (/from '@\/lib\/payments/.test(code(file))) offenders.push(`${file}: imports lib/payments`);
    }
    expect(offenders).toEqual([]);
  });

  /** AC-5 — spec 024 owns payout execution entirely; this spec produces only the eligibility fact. */
  it('writes no payouts row and computes no fee', () => {
    const offenders: string[] = [];
    for (const file of PAYMENT_FILES) {
      const source = code(file);
      if (/INSERT INTO\s+"?payouts/i.test(source) || /UPDATE\s+"?payouts/i.test(source)) {
        offenders.push(`${file}: writes a payouts row`);
      }
      if (/payoutMethods|payout_methods/.test(source)) offenders.push(`${file}: touches payout methods`);
    }
    expect(offenders).toEqual([]);
  });

  /** §7 — refunds (022) and disputes (031) stay outside this spec; only the dispute PORT is read. */
  it('implements no refund and no dispute resolution', () => {
    const offenders: string[] = [];
    for (const file of PAYMENT_FILES) {
      const source = code(file);
      if (/to:\s*'(refunded|partially_refunded)'/.test(source)) offenders.push(`${file}: performs a refund transition`);
      if (/INSERT INTO\s+"?refunds/i.test(source)) offenders.push(`${file}: writes a refund row`);
      if (/INSERT INTO\s+"?disputes/i.test(source)) offenders.push(`${file}: writes a dispute row`);
      if (/to:\s*'disputed'/.test(source)) offenders.push(`${file}: transitions a booking to disputed`);
    }
    expect(offenders).toEqual([]);
  });

  /** §3 "Booking boundary" — `bookings.status` is only ever written through spec 020's primitive. */
  it('never writes bookings.status with its own SQL', () => {
    const offenders: string[] = [];
    for (const file of PAYMENT_FILES) {
      if (/UPDATE\s+bookings[\s\S]{0,200}SET[\s\S]{0,200}\bstatus\s*=/i.test(code(file))) {
        offenders.push(`${file}: writes bookings.status directly`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * §3 "Transaction and lock ordering" — a provider call is never made inside a transaction. A
   * network round trip while a booking row lock is held would block every other writer on that
   * booking for the duration of the provider's latency.
   */
  it('makes no provider call inside a database transaction', () => {
    const offenders: string[] = [];
    for (const file of PAYMENT_FILES) {
      if (file.startsWith(PROVIDER_DIR)) continue;
      const source = code(file);
      for (const match of source.matchAll(/transaction\(async \(tx\) => \{/g)) {
        const body = transactionBody(source, (match.index ?? 0) + match[0].length - 1);
        if (/\bprovider\.(authorize|capture|voidAuthorization|getStatus)\(/.test(body)) {
          offenders.push(`${file}: calls the provider inside a transaction`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The text between a transaction callback's opening brace and its matching close.
 *
 * A fixed-size window is not good enough here: it spills into whatever follows the transaction —
 * which, in this spec, is deliberately where the provider call lives — and would report every
 * correct file as an offender. `openIndex` points at the `{`.
 */
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
