import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PLAYWRIGHT_TMP_DIR, personaStatePath } from '../personas';
import type { Persona } from './routes';

/**
 * Spec 043 §3.3/§3.9 — the run-time data behind the manifest's `{placeholders}`, created ONCE per run in the
 * isolated browser test database (`*_browser_test`, which playwright.config.ts points DATABASE_URL at):
 *
 * - one real journey built through the spec 015→020 path the integration suites use
 *   (`seedBookingScenario`: request → matching → offer → accept; then spec 020's own `createBooking`), so the
 *   request, compare, booking, payment and review screens render real rows;
 * - the journey's own customer and provider sessions, saved as Playwright storage states;
 * - `urdu-locale` switched on (it has no env override — spec 042 §4) for the §3.9 parity checks.
 *
 * Several Playwright workers may ask at once: the first takes a file lock and seeds, the rest wait and read
 * the result. The seeding itself is browser/a11y/seed.ts.
 */
export interface A11yFixtures {
  categoryId: string;
  serviceId: string;
  requestId: string;
  bookingId: string;
  /** A well-formed id that matches no booking — drives the forced error state. */
  missingId: string;
  customerUserId: string;
}

const DIR = path.join(PLAYWRIGHT_TMP_DIR, 'a11y');
const RESULT = path.join(DIR, 'fixtures.json');
const LOCK = path.join(DIR, 'fixtures.lock');
const JOURNEY_STATE = { customer: path.join(DIR, 'journey-customer.json'), provider: path.join(DIR, 'journey-provider.json') };
const GUEST_STATE = path.join(DIR, 'guest.json');
const TSX_CLI = require.resolve('tsx/cli');

/** The spec 007 first-run overlay's "seen" flag, pre-set everywhere except the manifest's first-visit entry. */
export const ONBOARDING_SEEN_KEY = 'apuriva_onboarding_seen';

/** Runs browser/a11y/seed.ts through tsx (which resolves the app's `@/` imports) and returns its fixtures. */
function seed(baseURL: string): A11yFixtures {
  const out = execFileSync(process.execPath, [TSX_CLI, path.join(__dirname, 'seed.ts'), baseURL, DIR], {
    cwd: path.join(__dirname, '..', '..'),
    env: process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out.trim().split(/\r?\n/).pop()!) as A11yFixtures;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The browser database is recreated on every run, and spec 046's global setup rewrites the admin session
 * each run — so fixtures older than that file belong to a previous database and are discarded.
 */
function currentResult(): A11yFixtures | null {
  if (!existsSync(RESULT)) return null;
  const runStarted = statSync(personaStatePath('admin')).mtimeMs;
  if (statSync(RESULT).mtimeMs < runStarted) {
    rmSync(RESULT, { force: true });
    return null;
  }
  return JSON.parse(readFileSync(RESULT, 'utf8')) as A11yFixtures;
}

export async function a11yFixtures(baseURL: string): Promise<A11yFixtures> {
  mkdirSync(DIR, { recursive: true });
  for (let waited = 0; waited < 180_000; waited += 250) {
    const ready = currentResult();
    if (ready) return ready;
    let fd: number;
    try {
      fd = openSync(LOCK, 'wx');
    } catch {
      await sleep(250);
      continue;
    }
    try {
      const fixtures = seed(baseURL);
      writeFileSync(RESULT, JSON.stringify(fixtures));
      return fixtures;
    } finally {
      closeSync(fd);
      rmSync(LOCK, { force: true });
    }
  }
  throw new Error('a11y fixtures: timed out waiting for another worker to seed');
}

/** The storage state for a manifest persona: the seeded journey's own customer/provider, spec 046's admin. */
export function stateFor(persona: Persona): string {
  if (persona === 'customer' || persona === 'provider') return JOURNEY_STATE[persona];
  if (persona === 'admin') return personaStatePath('admin');
  return GUEST_STATE;
}

export function resolvePath(template: string, f: A11yFixtures): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = (f as unknown as Record<string, string>)[name];
    if (!value) throw new Error(`a11y fixtures: no value for {${name}} in "${template}"`);
    return value;
  });
}
