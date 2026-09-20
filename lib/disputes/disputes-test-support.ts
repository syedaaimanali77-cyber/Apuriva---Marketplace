/**
 * Spec 031 §6 fixtures.
 *
 * Everything is built through the REAL path: the booking runs the genuine spec 015→020 flow, the
 * payment is genuinely authorized and captured by spec 021, and the protection window is opened
 * with spec 021's own primitives (via spec 024's `seedProtectedBooking`, which exists precisely
 * because a `protected` + `held` booking is what the payout pipeline needs too). Nothing fakes a
 * row that an application path is supposed to create — a faked booking would not prove that
 * eligibility is what admits a dispute in the first place.
 *
 * `seedProtectedBooking()` gives exactly the state AC-1 requires: `bookings.status = 'protected'`
 * and `payments.protection_state = 'held'`.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows } from '@/lib/offers/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { resetFileContextPolicies } from '@/lib/files/contexts/registry';
import { registerShippedFileContextPolicies } from '@/lib/files/contexts/policies';
import { registerBookingTransitions } from '@/lib/bookings';
import { registerDisputeGate, resetDisputeGate } from '@/lib/payments/protection-window';
import {
  seedProtectedBooking,
  usePayoutIntegration,
  resetPayoutIntegration,
  type SettledBooking,
} from '@/lib/payouts/payouts-test-support';
import { disputeGate } from './gate';
import { registerDisputeEvidenceContext } from './evidence-policy';
import { SPEC_031_BOOKING_TRANSITIONS } from './index';

export { seedProtectedBooking, type SettledBooking } from '@/lib/payouts/payouts-test-support';
export { isDatabaseReachable } from '@/lib/bookings/bookings-test-support';
export { registerAdmin, grantRole, seedPermission, registerAdminWithPermission, type TestAdmin } from '@/app/api/v1/admin/admin-rbac-test-support';

export const BASE = 'http://localhost/api/v1';

export function freshKey(prefix = 'dispute'): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Puts the process in the state `instrumentation.ts` produces for this spec.
 *
 * Vitest gives each test file its own module registry, so the transitions `lib/disputes/index.ts`
 * registers at import have to be re-registered per file — and AFTER spec 021's/022's own resets,
 * which clear them. This is the same dance `refunds-test-support.ts` performs.
 */
export function useDisputeIntegration(): void {
  usePayoutIntegration();
  registerBookingTransitions('spec 031 (disputes)', SPEC_031_BOOKING_TRANSITIONS);
  registerDisputeGate(disputeGate);
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
  registerDisputeEvidenceContext();
  resetRateLimitState();
}

/** Returns spec 021's port to its documented pre-031 default. */
export function resetDisputeIntegrationForTests(): void {
  resetPayoutIntegration();
  resetDisputeGate();
  resetFileContextPolicies();
  registerShippedFileContextPolicies();
}

/** Seeds the three permissions migration 0028 seeds, for whichever role a test needs. */
export async function seedDisputePermissions(role: 'trust_safety_admin' | 'operations_admin' | 'super_admin'): Promise<void> {
  const { seedPermission } = await import('@/app/api/v1/admin/admin-rbac-test-support');
  await seedPermission(role, 'disputes', 'read', 'low');
  if (role !== 'operations_admin') {
    await seedPermission(role, 'disputes', 'resolve', 'medium');
    await seedPermission(role, 'disputes', 'review_appeal', 'medium');
  }
}

/** A Trust & Safety admin holding all three dispute permissions. */
export async function trustSafetyAdmin() {
  const { registerAdmin, grantRole } = await import('@/app/api/v1/admin/admin-rbac-test-support');
  const admin = await registerAdmin();
  await grantRole(admin, 'trust_safety_admin');
  await seedDisputePermissions('trust_safety_admin');
  return admin;
}

/** An Operations admin: `disputes/read` only, so they can watch but never decide. */
export async function operationsAdmin() {
  const { registerAdmin, grantRole } = await import('@/app/api/v1/admin/admin-rbac-test-support');
  const admin = await registerAdmin();
  await grantRole(admin, 'operations_admin');
  await seedDisputePermissions('operations_admin');
  return admin;
}

export async function disputeRow(disputeId: string): Promise<Record<string, unknown>> {
  const [row] = await queryRows<Record<string, unknown>>(getDb(), sql`SELECT * FROM disputes WHERE id = ${disputeId}`);
  return row!;
}

export async function resolutionRow(disputeId: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await queryRows<Record<string, unknown>>(
    getDb(),
    sql`SELECT * FROM dispute_resolutions WHERE dispute_id = ${disputeId}`,
  );
  return row;
}

export async function appealRow(disputeId: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await queryRows<Record<string, unknown>>(
    getDb(),
    sql`SELECT * FROM dispute_appeals WHERE dispute_id = ${disputeId}`,
  );
  return row;
}

export async function bookingStatusOf(bookingId: string): Promise<string> {
  const [row] = await queryRows<{ status: string }>(getDb(), sql`SELECT status FROM bookings WHERE id = ${bookingId}`);
  return row!.status;
}

export async function protectionStateOf(bookingId: string): Promise<string | null> {
  const [row] = await queryRows<{ protection_state: string | null }>(
    getDb(),
    sql`SELECT protection_state FROM payments WHERE booking_id = ${bookingId}`,
  );
  return row?.protection_state ?? null;
}

/** Counts `security_events` rows of a given type for a dispute — the audit assertions' primitive. */
export async function disputeAuditCount(eventType: string, targetId?: string): Promise<number> {
  const [row] = await queryRows<{ total: string }>(
    getDb(),
    targetId
      ? sql`SELECT count(*)::text AS total FROM security_events
             WHERE event_type = ${eventType} AND metadata->>'targetId' = ${targetId}`
      : sql`SELECT count(*)::text AS total FROM security_events WHERE event_type = ${eventType}`,
  );
  return Number(row?.total ?? 0);
}

/** Moves a resolution's `resolved_at` into the past so the appeal window is elapsed. */
export async function backdateResolution(disputeId: string, days: number): Promise<void> {
  await getDb().execute(
    sql`UPDATE dispute_resolutions
           SET resolved_at = resolved_at - make_interval(days => ${days})
         WHERE dispute_id = ${disputeId}`,
  );
}

/** The customer's and provider's user ids for a seeded booking. */
export function partiesOf(seeded: SettledBooking): { customerUserId: string; providerUserId: string } {
  return {
    customerUserId: seeded.scenario.customer.userId,
    providerUserId: seeded.scenario.provider.userId,
  };
}
