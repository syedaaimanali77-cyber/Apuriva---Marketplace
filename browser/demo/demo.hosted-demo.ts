import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';
import { generateTotpCode } from '../../lib/auth/totp';
import { PRODUCTION_BASE_URL, demoServerEnv } from './demo-environment';

/**
 * Spec 045 — the hosted demo, verified in a real browser against the production build (`NODE_ENV=production`)
 * configured as a demo deployment (§3.1: `APP_ENV=staging`, `demo-mode` on, a `_demo` database, sandbox
 * adapters). A second server from the same build runs with `APP_ENV=production`.
 */
const DATABASE_URL = process.env.DEMO_BROWSER_DATABASE_URL!;
const ROOT = path.join(__dirname, '..', '..');

async function query<T>(text: string, values: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, values)).rows as T[];
  } finally {
    await client.end();
  }
}

interface Me {
  id: string;
  isDemo: boolean;
}

async function me(page: Page): Promise<Me> {
  const res = await page.request.get('/api/v1/users/me');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { data: Me }).data;
}

const BANNER = 'You are exploring a demo. Everything here is sample data: no real money moves and no messages are sent.';

async function tryAs(page: Page, persona: 'Customer' | 'Provider'): Promise<Me> {
  await page.goto('/demo');
  await expect(page.getByRole('heading', { name: 'Try APURIVA' })).toBeVisible();
  await page.getByRole('button', { name: `Try as ${persona}` }).click();
  await page.waitForURL(persona === 'Customer' ? /\/$/ : /\/provider\/dashboard$/, { timeout: 60_000 });
  await expect(page.getByText(BANNER)).toBeVisible();
  const user = await me(page);
  expect(user.isDemo).toBe(true);
  return user;
}

/** The demo set a persona user belongs to (users.demo_set_id). */
async function setOf(userId: string): Promise<string> {
  const [row] = await query<{ demo_set_id: string }>('SELECT demo_set_id FROM users WHERE id = $1', [userId]);
  return row!.demo_set_id;
}

async function expectRendersWithoutError(page: Page, url: string): Promise<void> {
  const res = await page.goto(url);
  expect(res?.status(), url).toBe(200);
  await expect(page.locator('main').first(), url).toBeVisible();
  await expect(page.getByText(BANNER), url).toBeVisible();
  await expect(page.getByRole('heading', { name: /something went wrong|couldn.t load/i }), url).toHaveCount(0);
}

test.describe('hosted demo (spec 045)', () => {
  test('AC-3/AC-7: the entry page and the banner render for a guest', async ({ page }) => {
    const res = await page.goto('/demo');
    expect(res?.status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Try as Customer' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Try as Provider' })).toBeEnabled();
    await expect(page.getByText(BANNER)).toBeVisible();
  });

  test('AC-1/AC-2/AC-3/AC-4/AC-6: customer journey — one click, sample data, sandbox payments, inbox-only notifications', async ({ page }) => {
    const customer = await tryAs(page, 'Customer');
    const setId = await setOf(customer.id);

    // AC-3: every seeded person carries "(Demo)"; AC-6: no deliverable contact address.
    const people = await query<{ email: string; display_name: string | null; phone_number: string | null }>(
      `SELECT u.email, cp.display_name, u.phone_number FROM users u JOIN customer_profiles cp ON cp.user_id = u.id WHERE u.demo_set_id = $1`,
      [setId],
    );
    expect(people.length).toBeGreaterThanOrEqual(6);
    for (const person of people) {
      expect(person.display_name).toMatch(/\(Demo\)$/);
      expect(person.email).toMatch(/\.invalid$/);
      expect(person.phone_number).toBeNull();
    }

    for (const url of ['/bookings', '/requests', '/explore', '/account', '/account/notifications']) await expectRendersWithoutError(page, url);
    await page.goto('/bookings');
    await expect(page.getByText(/\(Demo\)/).first()).toBeVisible();

    // AC-4: a confirmed booking's payment was confirmed by the SANDBOX payment provider.
    const [confirmed] = await query<{ id: string }>(
      `SELECT b.id FROM bookings b JOIN customer_profiles cp ON cp.id = b.customer_profile_id
        WHERE cp.user_id = $1 AND b.status = 'confirmed' LIMIT 1`,
      [customer.id],
    );
    await page.goto(`/bookings/${confirmed!.id}/payment`);
    await expect(page.getByText('Payment confirmed by the payment provider.')).toBeVisible();

    // AC-4: the pending booking carries the sandbox's documented requires-action amount, so paying it in the browser
    // goes through spec 021's real authorize route to the sandbox adapter, and comes back requiring action — it never
    // succeeds by fabrication.
    const [pending] = await query<{ id: string }>(
      `SELECT b.id FROM bookings b JOIN customer_profiles cp ON cp.id = b.customer_profile_id
        WHERE cp.user_id = $1 AND b.status = 'pending' LIMIT 1`,
      [customer.id],
    );
    await page.goto(`/bookings/${pending!.id}/payment`);
    const authorize = page.waitForResponse((r) => r.url().endsWith(`/api/v1/bookings/${pending!.id}/payment/authorize`));
    await page.getByRole('button', { name: /Pay now|Try again/ }).first().click();
    const authorized = await authorize;
    // Spec 021's documented contract for this outcome: 422 PAYMENT_REQUIRES_ACTION, and the payment stays
    // `requires_action` — the extra verification step the customer would complete with a real provider.
    expect(authorized.status()).toBe(422);
    expect(((await authorized.json()) as { code: string }).code).toBe('PAYMENT_REQUIRES_ACTION');
    const [stillPending] = await query<{ status: string; booking_status: string }>(
      `SELECT p.status, b.status AS booking_status FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.id = $1`,
      [pending!.id],
    );
    expect(stillPending).toEqual({ status: 'requires_action', booking_status: 'pending' });

    // AC-4/AC-6: every payment row of this set came from the sandbox; nothing was ever queued for delivery.
    const providers = await query<{ provider_name: string }>(
      `SELECT DISTINCT p.provider_name FROM payments p JOIN bookings b ON b.id = p.booking_id
         JOIN customer_profiles cp ON cp.id = b.customer_profile_id JOIN users u ON u.id = cp.user_id WHERE u.demo_set_id = $1`,
      [setId],
    );
    expect(providers.map((p) => p.provider_name)).toEqual(['sandbox']);
    await page.goto('/account/notifications');
    const [inbox] = await query<{ n: number; deliveries: number }>(
      `SELECT count(*)::int AS n,
              (SELECT count(*)::int FROM notification_deliveries d JOIN notifications x ON x.id = d.notification_id
                 JOIN users u ON u.id = x.recipient_user_id WHERE u.demo_set_id = $1) AS deliveries
         FROM notifications n JOIN users u ON u.id = n.recipient_user_id WHERE u.demo_set_id = $1`,
      [setId],
    );
    expect(inbox!.n).toBeGreaterThanOrEqual(3);
    expect(inbox!.deliveries).toBe(0);
  });

  test('AC-1/AC-2: provider journey, and the stored portfolio placeholders are served', async ({ page }) => {
    const provider = await tryAs(page, 'Provider');
    for (const url of ['/provider/dashboard', '/provider/requests', '/provider/schedule', '/provider/earnings']) await expectRendersWithoutError(page, url);

    // Spec 027 storage + scanning in the hosted configuration: a placeholder was stored, scanned clean and is served.
    const setId = await setOf(provider.id);
    const [asset] = await query<{ id: string }>(
      `SELECT fa.id FROM file_assets fa JOIN provider_profiles pp ON pp.id = fa.context_id JOIN users u ON u.id = pp.user_id
        WHERE u.demo_set_id = $1 AND fa.context_type = 'portfolio' AND fa.status = 'ready' AND fa.scan_outcome = 'clean' LIMIT 1`,
      [setId],
    );
    expect(asset).toBeDefined();
    // The viewer asks for a link (spec 027: a signed URL, since no CDN is configured), then fetches the bytes.
    const link = await page.request.get(`/api/v1/files/${asset!.id}`);
    expect(link.status()).toBe(200);
    const { url } = ((await link.json()) as { data: { url: string } }).data;
    const content = await page.request.get(new URL(url, page.url()).toString());
    expect(content.status()).toBe(200);
    expect(content.headers()['content-type']).toContain('image/png');
    expect((await content.body()).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  test('AC-5: Reset demo signs in to a fresh set and leaves the old one untouched', async ({ page }) => {
    const before = await tryAs(page, 'Customer');
    const oldSet = await setOf(before.id);
    const [{ n: oldBookings }] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings b JOIN customer_profiles cp ON cp.id = b.customer_profile_id
         JOIN users u ON u.id = cp.user_id WHERE u.demo_set_id = $1`,
      [oldSet],
    ) as [{ n: number }];

    await page.goto('/account');
    await page.getByRole('button', { name: 'Reset demo' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText('Reset your demo?')).toBeVisible();
    const resetResponse = page.waitForResponse((r) => r.url().endsWith('/api/v1/demo/reset'), { timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Reset demo' }).click();
    const reset = await resetResponse;
    expect(reset.status(), await reset.text()).toBe(200);
    await expect.poll(async () => (await me(page)).id, { timeout: 60_000 }).not.toBe(before.id);

    const after = await me(page);
    expect(after.isDemo).toBe(true);
    expect(await setOf(after.id)).not.toBe(oldSet);
    const [{ n: stillThere }] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings b JOIN customer_profiles cp ON cp.id = b.customer_profile_id
         JOIN users u ON u.id = cp.user_id WHERE u.demo_set_id = $1`,
      [oldSet],
    ) as [{ n: number }];
    expect(stillThere).toBe(oldBookings);
  });

  test('§3.9: an operator-provisioned admin evaluator signs in with mandatory MFA and reaches the admin console', async ({ page }) => {
    const email = `evaluator-${Date.now()}@example.invalid`;
    const output = execFileSync(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'scripts', 'demo-create-admin.ts'), '--email', email, '--role', 'operations_admin'],
      { cwd: ROOT, env: { ...process.env, ...demoServerEnv(DATABASE_URL, 'staging', 3200) }, encoding: 'utf8' },
    );
    const password = /One-time password, shown only now: (\S+)/.exec(output)?.[1];
    expect(password, output).toBeTruthy();

    await page.goto('/login');
    await page.getByRole('tab', { name: 'Email' }).click();
    await page.getByLabel(/^Email/).fill(email);
    await page.getByLabel(/^Password/).fill(password!);
    await page.getByRole('button', { name: 'Log in' }).click();

    // No admin session without MFA (D-2): the evaluator enrols an authenticator, then proves it with a code.
    await expect(page.getByRole('heading', { name: 'Set up two-factor authentication' })).toBeVisible();
    const setupKey = (await page.getByTestId('mfa-setup-key').textContent())!.trim();
    expect(setupKey).toMatch(/^[A-Z2-7]{32}$/);
    await page.getByLabel('Authenticator code').fill(generateTotpCode(setupKey));
    await page.waitForURL(/\/$/, { timeout: 60_000 });

    const res = await page.goto('/admin');
    expect(res?.status()).toBe(200);
    await expect(page.locator('main').first()).toBeVisible();
    const [admin] = await query<{ is_demo: boolean; enrolled: boolean }>(
      `SELECT u.is_demo, ap.mfa_enrolled_at IS NOT NULL AS enrolled FROM users u JOIN admin_profiles ap ON ap.user_id = u.id WHERE u.email = $1`,
      [email],
    );
    expect(admin).toEqual({ is_demo: true, enrolled: true });
  });

  test('AC-7 + DEP-1: with APP_ENV=production the demo is refused and writes nothing', async ({ page, request }) => {
    const [{ n: usersBefore }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM users') as [{ n: number }];

    await page.goto(`${PRODUCTION_BASE_URL}/demo`);
    await expect(page.getByRole('heading', { name: 'Demo is not available' })).toBeVisible();
    await expect(page.getByText(BANNER)).toHaveCount(0);

    const refused = await request.post(`${PRODUCTION_BASE_URL}/api/v1/demo/login`, { data: { persona: 'customer' } });
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('DEMO_NOT_AVAILABLE_IN_PRODUCTION');

    const [{ n: usersAfter }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM users') as [{ n: number }];
    expect(usersAfter).toBe(usersBefore);
  });
});
