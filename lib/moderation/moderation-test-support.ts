/**
 * Spec 038 §6 fixtures.
 *
 * Built through the REAL paths: accounts and sessions through spec 005, provider profiles through
 * spec 006's route, admins through spec 009's helpers, and the permissions THIS SPEC'S MIGRATION
 * (0033) seeds — no test re-seeds a moderation permission, so a mis-seeded tier would be caught.
 * Approval uses spec 009's own `decideAction()`.
 */
import { AUDIT_EVENTS } from '@/lib/audit/audit-test-support';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { decideAction } from '@/lib/admin-rbac/actions';
import { resetFileContextPolicies } from '@/lib/files/contexts/registry';
import { registerShippedFileContextPolicies } from '@/lib/files/contexts/policies';
import type { AdminRole } from '@/lib/types/admin-rbac';
import type { ModerationActionDto } from '@/lib/types/moderation';
import { registerAdmin, grantRole, type TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';
import { registerAndLogin, type TestSession } from '@/app/api/v1/users/me/privacy-test-support';
import { registerProvider, type ProviderFixture } from '@/app/api/v1/providers/availability-test-support';
import { authenticatedRequest } from '@/app/api/v1/auth/test-support';
import { initiateModerationAction, executeModerationAction, registerModerationIntegration, resetModerationIntegration } from './index';

export { isDatabaseReachable } from '@/app/api/v1/auth/test-support';
export { registerAndLogin, registerProvider, registerAdmin, grantRole, authenticatedRequest };
export type { TestAdmin, TestSession, ProviderFixture };

export const BASE = 'http://localhost/api/v1';

/** The state `instrumentation.ts` produces for this spec. */
export function useModerationIntegration(): void {
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
  registerModerationIntegration();
  resetRateLimitState();
}

/** Every port this spec touches, back to its documented pre-038 default. */
export function resetModerationForTests(): void {
  resetModerationIntegration();
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
}

export async function adminWithRole(role: AdminRole = 'trust_safety_admin'): Promise<TestAdmin> {
  const admin = await registerAdmin();
  await grantRole(admin, role);
  return admin;
}

/** Spec 009's approval by a second admin. */
export async function approve(approver: TestAdmin, adminActionId: string): Promise<void> {
  await decideAction({ approverUserId: approver.userId, adminActionId, decision: 'approved' });
}

export async function reject(approver: TestAdmin, adminActionId: string): Promise<void> {
  await decideAction({ approverUserId: approver.userId, adminActionId, decision: 'rejected' });
}

export async function initiate(admin: TestAdmin, body: Record<string, unknown>, key: string = randomUUID()) {
  return initiateModerationAction({ adminUserId: admin.userId, idempotencyKey: key, body: { reason: 'Test reason for moderation.', ...body }, correlationId: null });
}

/** initiate → second admin approves → initiator executes. */
export async function initiateApproveExecute(
  initiator: TestAdmin,
  approver: TestAdmin,
  body: Record<string, unknown>,
): Promise<ModerationActionDto> {
  const { action } = await initiate(initiator, body);
  await approve(approver, action.adminActionId!);
  return executeModerationAction({ adminUserId: initiator.userId, actionId: action.id, correlationId: null });
}

export async function userStatus(userId: string): Promise<string> {
  const [row] = await queryRows<{ lifecycle_status: string }>(getDb(), sql`SELECT lifecycle_status FROM users WHERE id = ${userId}`);
  return row!.lifecycle_status;
}

export async function providerStatus(providerProfileId: string): Promise<string> {
  const [row] = await queryRows<{ lifecycle_status: string }>(
    getDb(),
    sql`SELECT lifecycle_status FROM provider_profiles WHERE id = ${providerProfileId}`,
  );
  return row!.lifecycle_status;
}

export async function actionStatus(id: string): Promise<string> {
  const [row] = await queryRows<{ status: string }>(getDb(), sql`SELECT status FROM moderation_actions WHERE id = ${id}`);
  return row!.status;
}

export async function auditEvents(eventType: string, targetId: string): Promise<Array<{ metadata: Record<string, any>; user_id: string }>> {
  return queryRows(
    getDb(),
    sql`SELECT metadata, user_id FROM ${AUDIT_EVENTS} WHERE event_type = ${eventType} AND metadata->>'targetId' = ${targetId}
         ORDER BY created_at ASC`,
  );
}

export async function openSessionCount(userId: string): Promise<number> {
  const [row] = await queryRows<{ n: number }>(getDb(), sql`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${userId} AND revoked_at IS NULL`);
  return row!.n;
}

/** A route request as `session`, with CSRF and (for POST) a fresh Idempotency-Key unless given. */
export function asUser(
  session: TestSession,
  path: string,
  init?: { method?: string; body?: unknown; idempotencyKey?: string | null },
): Request {
  const method = init?.method ?? 'POST';
  const base = authenticatedRequest(`${BASE}${path}`, session.sessionId, session.csrfToken, {
    method,
    body: method === 'GET' ? undefined : (init?.body ?? {}),
  });
  if (method === 'GET' || init?.idempotencyKey === null) return base;
  const headers = new Headers(base.headers);
  headers.set('Idempotency-Key', init?.idempotencyKey ?? randomUUID());
  return new Request(base, { headers });
}

export async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

export async function seedCustomer(): Promise<TestSession> {
  return registerAndLogin();
}

export async function seedProvider(): Promise<ProviderFixture> {
  return registerProvider({ lifecycleStatus: 'active' });
}
