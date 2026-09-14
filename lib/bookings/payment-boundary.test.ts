import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEC_020_TRANSITIONS } from './state-machine';

/**
 * Spec 020 §3 "Payment boundary" (open question 2) — a SOURCE-LEVEL guard, so the boundary with
 * spec 021 cannot rot as either spec grows.
 *
 * The invariants asserted here are exactly the ones §3 states:
 *   - no spec 020 file transitions a booking to `protected` or `settled`;
 *   - this spec's migration seeds neither transition;
 *   - `lib/bookings/**` reads no payment state and imports no payment module;
 *   - this spec ships no cron/sweep/scheduler that could transition a booking (AC-7).
 */
const ROOT = join(__dirname, '..', '..');
const DOMAIN_DIR = join(ROOT, 'lib', 'bookings');
const ROUTES_DIR = join(ROOT, 'app', 'api', 'v1', 'bookings');
const MIGRATION = join(ROOT, 'drizzle', '0016_add_booking_creation_state_machine.sql');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Spec 021 owns `/bookings/{id}/payment/**` and `/bookings/{id}/price-adjustments/**`. Those route
 * files sit in the bookings URL namespace because a payment belongs to a booking, but they are not
 * SPEC 020 FILES — which is what every assertion below is about ("no spec 020 file transitions a
 * booking to `protected` or `settled`"), and the boundary they are scoped out of is a URL tree, not
 * the architectural rule.
 *
 * The architectural rule is untouched and still asserted at full strength: `lib/bookings/**` — every
 * module spec 020 actually owns — reads no payment state and imports no payment module, and so does
 * every spec 020 route. Spec 021 depends on spec 020 through `applyBookingTransition()` and the
 * registered `BookingConfirmationGate`; spec 020 depends on spec 021 through nothing at all.
 */
const SPEC_021_ROUTE_SEGMENTS = [join('[id]', 'payment'), join('[id]', 'price-adjustments')];

function isSpec021Route(file: string): boolean {
  return SPEC_021_ROUTE_SEGMENTS.some((segment) => file.includes(segment));
}

/** Production sources only — the test files themselves legitimately name the forbidden statuses. */
const PRODUCTION_FILES = [...sourceFiles(DOMAIN_DIR), ...sourceFiles(ROUTES_DIR)].filter(
  (file) => !/\.test\.tsx?$/.test(file) && !/test-support\.ts$/.test(file) && !isSpec021Route(file),
);

/**
 * These assertions are about CODE, not prose. Every module in this spec documents the boundary it
 * respects — `lifecycle.ts`'s header says in so many words that it contains no cron, sweep or
 * `actorRole: 'system'` call site — so matching raw file text would make a correct file fail for
 * describing its own correctness. Comments are stripped first, and only the remaining code is
 * searched.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('spec 020 / spec 021 payment boundary', () => {
  it('has production sources to check', () => {
    expect(PRODUCTION_FILES.length).toBeGreaterThan(5);
  });

  it('never transitions a booking to protected or settled', () => {
    // A transition is always `to: '<status>'` or a literal passed to applyBookingTransition.
    const offenders = PRODUCTION_FILES.filter((file) => {
      const source = code(file);
      return /\bto:\s*'(protected|settled)'/.test(source) || /'(protected|settled)'\s*,\s*actorRole/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it('declares neither transition in the in-code graph', () => {
    expect(SPEC_020_TRANSITIONS.some(([, to]) => to === 'protected' || to === 'settled')).toBe(false);
  });

  it('seeds neither transition in 0016', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const seedBlock = sql.slice(sql.indexOf('INSERT INTO "bookings_status_transitions"'));
    const values = seedBlock.slice(0, seedBlock.indexOf('ON CONFLICT'));
    expect(values).not.toMatch(/'protected'/);
    expect(values).not.toMatch(/'settled'/);
    expect(values).not.toMatch(/'failed'/);
    expect(values).not.toMatch(/'cancelled'/);
    expect(values).not.toMatch(/'disputed'/);
    expect(values).not.toMatch(/'refunded'/);
  });

  it('imports no payment module and reads no payment state', () => {
    const offenders: string[] = [];
    for (const file of PRODUCTION_FILES) {
      const source = code(file);
      if (/from '@?\/?.*\/payments?/.test(source)) offenders.push(`${file}: imports a payment module`);
      if (/\bfrom\s+payments\b|\bjoin\s+payments\b|\bpayouts\b/i.test(source)) offenders.push(`${file}: queries payments/payouts`);
      if (/protectionState|protectionWindow|PaymentDto/.test(source)) offenders.push(`${file}: reads payment state`);
    }
    expect(offenders).toEqual([]);
  });

  /** AC-7 — no autonomous transition: no cron route, sweep, scheduler, webhook or timer. */
  it('ships no cron, sweep, scheduler or timer that could transition a booking', () => {
    const offenders: string[] = [];
    for (const file of PRODUCTION_FILES) {
      const source = code(file);
      if (/setInterval|setTimeout|node-cron|CRON_SECRET/.test(source)) offenders.push(`${file}: contains a timer/cron hook`);
      if (/\bsweep\b/i.test(source)) offenders.push(`${file}: contains a sweep`);
    }
    expect(offenders).toEqual([]);
  });

  /** AC-7 — `system` exists in the vocabulary for spec 021, but no spec 020 call site passes it. */
  it('never passes actorRole: system from a spec 020 call site', () => {
    const offenders = PRODUCTION_FILES.filter((file) => {
      if (file.endsWith(join('lib', 'bookings', 'state-machine.ts'))) return false; // defines the type
      return /actorRole:\s*'system'/.test(code(file));
    });
    expect(offenders).toEqual([]);
  });
});
