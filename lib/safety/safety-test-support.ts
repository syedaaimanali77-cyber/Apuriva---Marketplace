/**
 * Spec 030 §6 fixtures.
 *
 * Everything is built through the REAL path: sessions through spec 005, admins and permissions
 * through spec 009's own seeding helpers, bookings and conversations through specs 015→025, and
 * evidence through spec 027's actual upload/finalize. Nothing fakes a row that an application path
 * is supposed to create, because a faked row would not prove that the policy is what stops a
 * foreign asset existing in the first place.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetFileContextPolicies } from '@/lib/files/contexts/registry';
import { registerShippedFileContextPolicies } from '@/lib/files/contexts/policies';
import { resetConversationBlockGate } from '@/lib/messaging/block-gate';
import { resetProviderBlockSource } from '@/lib/matching/block-source';
import { registerSafetyIntegration, resetSafetyRestrictionGate } from './index';

export { seedConfirmedBooking, useMessagingIntegration, resetMessagingIntegration, registerAdmin, grantRole } from '@/lib/messaging/messaging-test-support';
export { isDatabaseReachable, seedStranger } from '@/lib/bookings/bookings-test-support';
export { registerCustomer, sessionGet, sessionMutate, type TestSession } from '@/lib/matching/matching-test-support';
export { seedPermission, registerAdminWithPermission, type TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';

export const BASE = 'http://localhost/api/v1';

/** Puts the process in the state `instrumentation.ts` produces for this spec. */
export function useSafetyIntegration(): void {
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
  registerSafetyIntegration();
  // Deliberately left UNREGISTERED, exactly as production leaves it until spec 038 ships. A test
  // that wants the registered behaviour registers its own stub explicitly.
  resetSafetyRestrictionGate();
  resetRateLimitState();
}

/** Returns every port this spec touches to its documented pre-030 default. */
export function resetSafetyIntegrationForTests(): void {
  resetConversationBlockGate();
  resetProviderBlockSource();
  resetSafetyRestrictionGate();
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
}

/** A bare user with no profile, for block/report counterparties that need no role. */
export async function seedBareUser(): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO users (email, password_hash) VALUES (${`safety-${randomUUID()}@example.test`}, 'x') RETURNING id`,
  );
  return row!.id;
}

/** Inserts a safety report through the real creation path's shape, for read/transition fixtures. */
export async function seedSafetyReport(input: {
  reporterUserId: string;
  targetUserId: string;
  category?: string;
  description?: string;
}): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    getDb(),
    sql`INSERT INTO safety_reports
          (reporter_user_id, target_user_id, category, description, idempotency_key, idempotency_fingerprint)
        VALUES (${input.reporterUserId}, ${input.targetUserId}, ${input.category ?? 'harassment'},
                ${input.description ?? 'They shouted at me and would not leave the property.'},
                ${randomUUID()}, 'fp')
        RETURNING id`,
  );
  return row!.id;
}

export async function reportRow(reportId: string): Promise<Record<string, unknown>> {
  const [row] = await queryRows<Record<string, unknown>>(
    getDb(),
    sql`SELECT * FROM safety_reports WHERE id = ${reportId}`,
  );
  return row!;
}

export async function userLifecycleStatus(userId: string): Promise<string> {
  const [row] = await queryRows<{ lifecycle_status: string }>(
    getDb(),
    sql`SELECT lifecycle_status FROM users WHERE id = ${userId}`,
  );
  return row!.lifecycle_status;
}

/** Counts `security_events` rows of a given type for a report — the audit assertions' primitive. */
export async function safetyAuditCount(eventType: string, targetId?: string): Promise<number> {
  const [row] = await queryRows<{ total: string }>(
    getDb(),
    targetId
      ? sql`SELECT count(*)::text AS total FROM security_events
             WHERE event_type = ${eventType} AND metadata->>'targetId' = ${targetId}`
      : sql`SELECT count(*)::text AS total FROM security_events WHERE event_type = ${eventType}`,
  );
  return Number(row?.total ?? 0);
}
