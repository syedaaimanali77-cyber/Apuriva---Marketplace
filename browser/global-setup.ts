import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { request, type APIRequestContext, type FullConfig } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { PERSONA_STATE_DIR, personaStatePath, type Persona } from './personas';

/**
 * Spec 046 §3.6 — signs in the `customer`, `provider` and `admin` personas through the REAL API of the
 * running app (Playwright started it before this runs) and saves each session for the browser tests.
 *
 * The admin persona is not a shortcut: it is given a TOTP secret and completes spec 005's mandatory MFA
 * through `POST /api/v1/auth/mfa/verify` with a generated code, exactly as a person would. The only
 * direct database writes are the admin profile and role grant — there is no self-service "become admin".
 */
const PASSWORD = 'correct horse battery staple';

async function csrfToken(ctx: APIRequestContext): Promise<string> {
  const token = (await ctx.storageState()).cookies.find((c) => c.name === 'apuriva_csrf')?.value;
  if (!token) throw new Error('global-setup: no CSRF cookie after sign-in');
  return token;
}

async function expectOk(res: { ok: () => boolean; status: () => number; url: () => string; text: () => Promise<string> }): Promise<void> {
  if (!res.ok()) throw new Error(`global-setup: ${res.url()} → ${res.status()} ${await res.text()}`);
}

async function register(baseURL: string, persona: Persona): Promise<{ ctx: APIRequestContext; email: string }> {
  const ctx = await request.newContext({ baseURL });
  const email = `browser-${persona}-${randomUUID()}@example.test`;
  await expectOk(await ctx.post('/api/v1/auth/register', { data: { email, password: PASSWORD } }));
  return { ctx, email };
}

async function save(ctx: APIRequestContext, persona: Persona): Promise<void> {
  await ctx.storageState({ path: personaStatePath(persona) });
  await ctx.dispose();
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('global-setup: baseURL is not configured');
  mkdirSync(PERSONA_STATE_DIR, { recursive: true });

  const customer = await register(baseURL, 'customer');
  await save(customer.ctx, 'customer');

  const provider = await register(baseURL, 'provider');
  const providerCsrf = { 'x-csrf-token': await csrfToken(provider.ctx) };
  await expectOk(await provider.ctx.post('/api/v1/users/me/provider-profile', { headers: providerCsrf }));
  await expectOk(await provider.ctx.patch('/api/v1/users/me/active-mode', { headers: providerCsrf, data: { mode: 'provider' } }));
  await save(provider.ctx, 'provider');

  const admin = await register(baseURL, 'admin');
  await admin.ctx.dispose();
  // App modules are imported only here, after playwright.config.ts pointed DATABASE_URL at the browser database.
  const { getDb, getPool } = await import('../lib/db');
  const { adminProfiles, adminRoleAssignments, roles, users } = await import('../lib/db/schema');
  const { generateTotpCode, generateTotpSecret } = await import('../lib/auth/totp');
  const { encryptTotpSecret } = await import('../lib/auth/totp-secret-crypto');
  const secret = generateTotpSecret();
  const [user] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, admin.email));
  const [profile] = await getDb()
    .insert(adminProfiles)
    .values({ userId: user!.id, totpSecretEncrypted: encryptTotpSecret(secret), mfaEnrolledAt: new Date() })
    .returning({ id: adminProfiles.id });
  const [superAdmin] = await getDb().select({ id: roles.id }).from(roles).where(eq(roles.name, 'super_admin'));
  await getDb().insert(adminRoleAssignments).values({ adminProfileId: profile!.id, roleId: superAdmin!.id });
  await getPool().end();

  const adminCtx = await request.newContext({ baseURL });
  await expectOk(await adminCtx.post('/api/v1/auth/login', { data: { email: admin.email, password: PASSWORD } }));
  await expectOk(
    await adminCtx.post('/api/v1/auth/mfa/verify', { headers: { 'x-csrf-token': await csrfToken(adminCtx) }, data: { code: generateTotpCode(secret) } }),
  );
  await save(adminCtx, 'admin');
}
