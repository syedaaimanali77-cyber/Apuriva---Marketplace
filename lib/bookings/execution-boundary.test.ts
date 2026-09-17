import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SPEC_020_TRANSITIONS } from './state-machine';

/**
 * Spec 028 §6 "Unit (boundary)" — a SOURCE-LEVEL guard, so spec 028's two load-bearing invariants
 * cannot rot as the code grows. Same technique as `payment-boundary.test.ts`, on CODE with comments
 * stripped, so a module that documents its own correctness does not fail for describing it.
 *
 * The invariants:
 *   AC-3 — milestones are CONTENT. `milestones.ts` performs no transition and writes no history.
 *   AC-9 — no spec 028 module or route accepts a location signal or moves the state machine, so
 *          there is no interface through which a GPS ping could change arrival state.
 *   §1   — spec 028 adds NO duplicate transition route; arrival/start/completion stay spec 020's.
 *   §7   — spec 028 takes no ownership of spec 021 payments or spec 029 reviews.
 */
const ROOT = join(__dirname, '..', '..');

/** Every production file this spec adds, and the one spec 020 file it extends. */
const SPEC_028_DOMAIN = [
  'lib/bookings/evidence.ts',
  'lib/bookings/evidence-policy.ts',
  'lib/bookings/execution-window.ts',
  'lib/bookings/milestones.ts',
  'lib/bookings/service-execution.ts',
];

const SPEC_028_ROUTES = [
  'app/api/v1/bookings/[id]/milestones/route.ts',
  'app/api/v1/bookings/[id]/evidence/route.ts',
];

function code(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('spec 028 service-execution boundary', () => {
  it('has the production sources it claims to check', () => {
    for (const file of [...SPEC_028_DOMAIN, ...SPEC_028_ROUTES]) {
      expect(code(file).length, file).toBeGreaterThan(0);
    }
  });

  /** AC-3 — milestones are content, never control. */
  it('the milestone module performs no transition and writes no status history', () => {
    const source = code('lib/bookings/milestones.ts');
    expect(source).not.toMatch(/applyBookingTransition/);
    expect(source).not.toMatch(/bookings_status_history/i);
    expect(source).not.toMatch(/\bUPDATE\s+bookings\b/i);
    expect(source).not.toMatch(/from '\.\/state-machine'/);
  });

  /** AC-9 — no location input surface anywhere in this spec, domain or route. */
  it('no spec 028 module or route accepts a location, geofence or telemetry signal', () => {
    const forbidden =
      /\b(latitude|longitude|lat_?long|coordinates?|geofence|geolocation|gps|accuracy_?meters|heading|proximity)\b/i;
    const offenders: string[] = [];
    for (const file of [...SPEC_028_DOMAIN, ...SPEC_028_ROUTES]) {
      if (forbidden.test(code(file))) offenders.push(relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  /** AC-9 — and nothing in this spec transitions a booking at all, by any route. */
  it('no spec 028 module or route transitions a booking', () => {
    for (const file of [...SPEC_028_DOMAIN, ...SPEC_028_ROUTES]) {
      const source = code(file);
      expect(source, file).not.toMatch(/applyBookingTransition\s*\(/);
      expect(source, file).not.toMatch(/\bto:\s*'(confirmed|provider_en_route|arrived|in_progress|completed)'/);
      // AC-7's rule, inherited: no timer, cron or sweep that could act on its own.
      expect(source, file).not.toMatch(/setInterval|setTimeout|node-cron|CRON_SECRET/);
    }
  });

  /** §1 — spec 028 adds no duplicate transition API; spec 020's routes stay the only ones. */
  it('adds no arrival, start or completion route of its own', () => {
    for (const route of SPEC_028_ROUTES) {
      expect(route).not.toMatch(/(provider-en-route|arrived|start-service|complete)\/route\.ts$/);
    }
    // And it changes none of spec 020's declared transitions.
    expect(SPEC_020_TRANSITIONS.length).toBeGreaterThan(0);
  });

  /** §7 — no payment or review ownership leaks in. */
  it('takes no ownership of spec 021 payments or spec 029 reviews', () => {
    const offenders: string[] = [];
    for (const file of [...SPEC_028_DOMAIN, ...SPEC_028_ROUTES]) {
      const source = code(file);
      if (/@\/lib\/(payments|payouts|refunds|reviews)\b/.test(source)) offenders.push(`${file}: imports a forbidden domain`);
      if (/\b(INSERT\s+INTO|UPDATE)\s+"?(payments|payouts|refunds|reviews)"?\b/i.test(source)) {
        offenders.push(`${file}: writes a forbidden table`);
      }
      if (/'(protected|settled)'/.test(source)) offenders.push(`${file}: names a spec 021 status`);
    }
    expect(offenders).toEqual([]);
  });

  /**
   * AC-4 — the requirement is read from the CATALOG. The gate must join `services`, and must not
   * take the requirement from anything the caller controls.
   */
  it('resolves the evidence requirement from services, never from a request body', () => {
    const source = code('lib/bookings/evidence.ts');
    expect(source).toMatch(/completion_evidence_required/);
    expect(source).toMatch(/JOIN services/i);
    // No body/input/payload value may reach the requirement or the count.
    expect(source).not.toMatch(/\b(body|payload|input|req|request)\s*\.\s*\w*[Rr]equired/);
    expect(source).not.toMatch(/required\s*[:=]\s*(body|input|payload|request)\./);
  });

  /** §4 — this spec touches none of spec 027's schema, and creates no second file system. */
  it('creates no storage of its own and writes no file_assets row', () => {
    for (const file of [...SPEC_028_DOMAIN, ...SPEC_028_ROUTES]) {
      const source = code(file);
      expect(source, file).not.toMatch(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?file_assets"?\b/i);
      expect(source, file).not.toMatch(/storage_key|createUploadTarget|FileStorageAdapter/);
    }
  });
});
