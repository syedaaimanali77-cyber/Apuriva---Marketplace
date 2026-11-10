/**
 * Spec 043 — seeds the accessibility journey fixtures into the browser test database. Run by
 * `browser/a11y/fixtures.ts` through `tsx` (which honours the repository's `@/` path alias, unlike
 * Playwright's loader), with DATABASE_URL already pointed at `*_browser_test` by playwright.config.ts.
 *
 * Usage: tsx browser/a11y/seed.ts <baseURL> <outDir>   → prints the fixtures JSON on its last stdout line.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { getDb, getPool } from '@/lib/db';
import { CSRF_COOKIE_NAME } from '@/lib/auth/csrf';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { createBookingBody, futureLocalSlot, seedBookingScenario } from '@/lib/bookings/bookings-test-support';
import { createBooking } from '@/lib/bookings/create';
import { assertBrowserDatabaseUrl } from '@/test/browser-database';

const ONBOARDING_SEEN_KEY = 'apuriva_onboarding_seen';

function storageState(baseURL: string, cookies: Record<string, string>): string {
  return JSON.stringify({
    cookies: Object.entries(cookies).map(([name, value]) => ({
      name, value, domain: new URL(baseURL).hostname, path: '/', expires: -1, httpOnly: name !== CSRF_COOKIE_NAME, secure: true, sameSite: 'Lax',
    })),
    origins: [{ origin: baseURL, localStorage: [{ name: ONBOARDING_SEEN_KEY, value: '1' }] }],
  });
}

async function main(): Promise<void> {
  const [baseURL, outDir] = process.argv.slice(2);
  if (!baseURL || !outDir) throw new Error('usage: tsx browser/a11y/seed.ts <baseURL> <outDir>');
  // Refuses anything but a local *_browser_test database — never the developer's or Vitest's.
  assertBrowserDatabaseUrl(process.env.DATABASE_URL ?? '');

  // The real spec 015→019 path (request → matching → offer → accept), then spec 020's own createBooking.
  // Booked at a fixed local time tomorrow, not `now + 24h`: a run started late in the evening would put
  // the slot across local midnight, outside every availability window (see `futureLocalSlot`).
  const scenario = await seedBookingScenario({ leadMinutes: 24 * 60 });
  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId, futureLocalSlot(1)));
  const rows = (await getDb().execute(sql`SELECT category_id FROM services WHERE id = ${scenario.serviceId}`)).rows as Array<{ category_id: string }>;

  // `urdu-locale` has no env override (spec 042 §4): switch it on in every environment row of this
  // isolated database, whichever environment `next start` resolves.
  await getDb().execute(sql`
    UPDATE feature_flag_environment_values v SET enabled = true, version = v.version + 1, updated_at = clock_timestamp()
      FROM feature_flags f WHERE f.id = v.feature_flag_id AND f.key = 'urdu-locale'
  `);

  const cookies = (s: { sessionId: string; csrfToken: string }) => ({ [SESSION_COOKIE_NAME]: s.sessionId, [CSRF_COOKIE_NAME]: s.csrfToken });
  writeFileSync(path.join(outDir, 'journey-customer.json'), storageState(baseURL, cookies(scenario.customer)));
  writeFileSync(path.join(outDir, 'journey-provider.json'), storageState(baseURL, cookies(scenario.provider)));
  writeFileSync(path.join(outDir, 'guest.json'), storageState(baseURL, {}));

  await getPool().end();
  console.log(
    JSON.stringify({
      categoryId: rows[0]!.category_id,
      serviceId: scenario.serviceId,
      requestId: scenario.requestId,
      bookingId: booking.id,
      missingId: randomUUID(),
      customerUserId: scenario.customer.userId,
    }),
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
