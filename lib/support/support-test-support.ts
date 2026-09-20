/**
 * Spec 032 §6 fixtures.
 *
 * Tickets are created through the REAL route wherever a test is about ticket behaviour, so the
 * fixtures prove the same code path the product uses. Only the surrounding cast — accounts, admin
 * roles, permission seeds — is built directly at the database layer, which is the shortcut specs
 * 029/030/031 already take for the same reason: there is no "become an admin" endpoint.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetFileContextPolicies } from '@/lib/files/contexts/registry';
import { registerShippedFileContextPolicies } from '@/lib/files/contexts/policies';
import { registerSupportAttachmentContext } from './attachment-policy';
import { IDEMPOTENCY_KEY_HEADER } from '@/lib/api/idempotency';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { CSRF_HEADER_NAME } from '@/lib/auth/csrf';

export { isDatabaseReachable } from '@/app/api/v1/auth/test-support';
export { registerAndLogin, type TestSession } from '@/app/api/v1/users/me/privacy-test-support';
export {
  registerAdmin,
  grantRole,
  seedPermission,
  registerAdminWithPermission,
  type TestAdmin,
} from '@/app/api/v1/admin/admin-rbac-test-support';

export const BASE = 'http://localhost/api/v1';

export function freshKey(prefix = 'support'): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Puts the process in the state `instrumentation.ts` produces for this spec.
 *
 * Vitest gives each test file its own module registry, so the file-context policy has to be
 * re-registered per file — and AFTER spec 027's own reset, which clears it. This is the same dance
 * `disputes-test-support.ts` performs.
 */
export function useSupportIntegration(): void {
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
  registerSupportAttachmentContext();
  resetRateLimitState();
}

/** Returns spec 027's registry to its documented pre-032 state (support context unregistered). */
export function resetSupportIntegrationForTests(): void {
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
  resetRateLimitState();
}

/** A request carrying a session cookie, the CSRF header and an idempotency key. */
export function supportRequest(
  url: string,
  session: { sessionId: string; csrfToken: string },
  init?: { method?: string; body?: unknown; idempotencyKey?: string },
): Request {
  const headers: Record<string, string> = {
    cookie: `${SESSION_COOKIE_NAME}=${session.sessionId}`,
    [CSRF_HEADER_NAME]: session.csrfToken,
    'content-type': 'application/json',
  };
  const method = init?.method ?? 'POST';
  if (method !== 'GET') headers[IDEMPOTENCY_KEY_HEADER] = init?.idempotencyKey ?? freshKey('idem');

  return new Request(url, {
    method,
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** Seeds this spec's five permissions for a role, standing in for migration 0029's own seed. */
export async function seedSupportPermissions(
  seed: (role: 'support_admin' | 'operations_admin' | 'super_admin', resource: string, action: string, tier: 'low' | 'medium') => Promise<void>,
  role: 'support_admin' | 'operations_admin' | 'super_admin',
): Promise<void> {
  await seed(role, 'support', 'read', 'low');
  if (role === 'operations_admin') return; // read-only by design (DECIDED-9)
  await seed(role, 'support', 'assign', 'low');
  await seed(role, 'support', 'respond', 'low');
  await seed(role, 'support', 'triage', 'medium');
  await seed(role, 'support', 'resolve', 'medium');
}

/** Reads a ticket row straight from the database, for assertions the DTOs deliberately hide. */
export async function readTicketRow(ticketId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await queryRows<Record<string, unknown>>(
    getDb(),
    sql`SELECT * FROM support_tickets WHERE id = ${ticketId}`,
  );
  return rows[0];
}

/** Forces a ticket's SLA deadline into the past, so a breach can be asserted without waiting. */
export async function expireSla(ticketId: string): Promise<void> {
  await getDb().execute(
    sql`UPDATE support_tickets SET sla_deadline_at = clock_timestamp() - interval '1 hour' WHERE id = ${ticketId}`,
  );
}

/** Backdates a resolution so the reopen window has elapsed, for sweep and window tests. */
export async function backdateResolution(ticketId: string, days: number): Promise<void> {
  await getDb().execute(
    sql`UPDATE support_tickets
           SET resolved_at = clock_timestamp() - make_interval(days => ${days})
         WHERE id = ${ticketId}`,
  );
}
