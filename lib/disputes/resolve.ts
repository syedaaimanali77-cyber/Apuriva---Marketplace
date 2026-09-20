/**
 * Spec 031 §3 — claiming, resolving, and linking a refund approval chain (AC-3, AC-5, DECIDED-5).
 *
 * THIS MODULE MOVES NO MONEY. Search it for `INSERT INTO refunds`, `INSERT INTO payouts`,
 * `UPDATE payments SET status`, `resolvePaymentProvider` or `authorizeAndInitiate` and you will
 * find nothing — `lib/disputes/no-money-leak.test.ts` asserts that at source level. What a
 * resolution records is a PROPOSAL: a decision, a mandatory reasoning, and optionally an amount the
 * resolving admin thinks should go back to the customer.
 *
 * WHY A PROPOSAL AND NOT A REFUND. Migration `0018` seeds `refunds/override` to `finance_admin` and
 * `super_admin` ONLY, so a Trust & Safety admin resolving a dispute is structurally incapable of
 * creating a refund. That is not an obstacle to work around — it is the separation of duties that
 * makes the chain three-eyed:
 *
 *   1. T&S resolves and PROPOSES an amount            (here)
 *   2. Finance initiates `POST /api/v1/admin/refunds` (spec 022, tier `high`)
 *   3. a SECOND Finance/Super admin approves          (spec 009's `decideAction`)
 *   4. spec 022 creates the `refunds` row and calls the provider
 *
 * So the person who judges the dispute is never the person who authorizes the money.
 * `linkRefundApproval` records step 2's `adminActionId` — never a `refunds.id`, because no refund
 * row exists until step 4.
 *
 * AMOUNT VALIDATION IS A BOUNDS CHECK, NOT ARITHMETIC. The refundable position comes from spec
 * 022's `readRefundablePosition()` under the payment lock; this spec computes no fee, no proration
 * and no remaining balance of its own.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { isUniqueViolation, queryRows } from '@/lib/offers/db';
import { fitsWithinRemaining, readRefundablePosition } from '@/lib/refunds/amounts';
import type { AdminDisputeDto, DisputeResolutionDto } from '@/lib/types/disputes';
import {
  disputeAlreadyResolvedError,
  disputeNotFoundError,
  disputeRefundAlreadyLinkedError,
  disputeRefundAmountInvalidError,
  disputeStatusConflictError,
} from './errors';
import { requireDisputeResolvePermission } from './permissions';
import {
  auditDispute,
  DISPUTE_EVENT_TYPES,
  getDisputeForAdmin,
  loadResolutionRow,
  resolveAdminAccess,
  resolveRefundState,
} from './read';
import { toResolutionDto } from './rows';
import { isResolvable } from './transitions';
import { emitToBothParties } from './notifications';
import { evidenceDescriptors } from './evidence';
import { summarizeForTriage } from './ai-assist';
import type { ParsedLegalHold, ParsedLinkRefund, ParsedResolve } from './validation';

/**
 * `open -> under_review`. No reason required: claiming changes no outcome, it only records who is
 * working the case so two admins do not duplicate the effort.
 */
export async function claimDispute(
  disputeId: string,
  adminUserId: string,
  correlationId: string | null,
): Promise<AdminDisputeDto> {
  await resolveAdminAccess(disputeId, adminUserId, requireDisputeResolvePermission);

  const updated = await queryRows<{ id: string }>(
    getDb(),
    sql`UPDATE disputes
           SET status = 'under_review', claimed_by_admin_user_id = ${adminUserId},
               updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${disputeId} AND status = 'open'
         RETURNING id`,
  );
  if (updated.length === 0) {
    // Conditional update matched nothing: someone else claimed or resolved it first.
    const [current] = await queryRows<{ status: AdminDisputeDto['status'] }>(
      getDb(),
      sql`SELECT status FROM disputes WHERE id = ${disputeId}`,
    );
    if (!current) throw disputeNotFoundError();
    throw disputeStatusConflictError(current.status);
  }

  await auditDispute({
    actorUserId: adminUserId,
    eventType: DISPUTE_EVENT_TYPES.claimed,
    targetId: disputeId,
    correlationId,
  });

  return getDisputeForAdmin(disputeId, adminUserId, correlationId, requireDisputeResolvePermission);
}

/**
 * AC-3 — writes the single `dispute_resolutions` row and moves the dispute to `resolved`.
 *
 * NOTHING IS RELEASED HERE. The dispute is `resolved`, not `closed`, so `lib/disputes/gate.ts` still
 * answers `open: true` and the payment stays `disputed` for the whole appeal window. That is what
 * makes AC-4's "the money stays held" true without a second mechanism.
 */
export async function resolveDispute(
  disputeId: string,
  adminUserId: string,
  input: ParsedResolve,
  idempotency: { key: string; fingerprint: string },
  correlationId: string | null,
): Promise<DisputeResolutionDto> {
  const ownership = await resolveAdminAccess(disputeId, adminUserId, requireDisputeResolvePermission);
  const db = getDb();

  const existing = await loadResolutionRow(db, disputeId);
  if (existing) {
    // A replay of the same admin's same key returns the original; anything else is a real conflict.
    const [replay] = await queryRows<{ id: string }>(
      db,
      sql`SELECT id FROM dispute_resolutions WHERE dispute_id = ${disputeId} AND idempotency_key = ${idempotency.key}`,
    );
    if (replay) return toResolutionDto(existing, await resolveRefundState(db, existing));
    throw disputeAlreadyResolvedError();
  }
  if (!isResolvable(ownership.status)) throw disputeAlreadyResolvedError();

  try {
    await db.transaction(async (tx) => {
      // Lock the dispute, then the payment — the established `bookings -> payments -> disputes`
      // order, entered at the dispute because the booking is not written here.
      const [locked] = await queryRows<{ status: AdminDisputeDto['status'] }>(
        tx,
        sql`SELECT status FROM disputes WHERE id = ${disputeId} FOR UPDATE`,
      );
      if (!locked) throw disputeNotFoundError();
      if (!isResolvable(locked.status)) throw disputeAlreadyResolvedError();

      if (input.proposedRefundAmountMinorUnits !== null) {
        const [payment] = await queryRows<{ id: string; currency: string | null }>(
          tx,
          sql`SELECT p.id, p.charge_currency_code AS currency
                FROM payments p WHERE p.booking_id = ${ownership.bookingId} FOR UPDATE`,
        );
        if (!payment) throw disputeRefundAmountInvalidError('this booking has no payment to refund');

        // Spec 022's figure, read under spec 022's lock. This spec recomputes nothing.
        const position = await readRefundablePosition(tx, payment.id);
        if (input.proposedRefundCurrencyCode !== position.currencyCode) {
          throw disputeRefundAmountInvalidError(
            `the currency must match the payment's (${position.currencyCode || 'unknown'})`,
          );
        }
        if (!fitsWithinRemaining(input.proposedRefundAmountMinorUnits, position)) {
          throw disputeRefundAmountInvalidError('it exceeds the amount still refundable on this payment');
        }
      }

      await tx.execute(
        sql`INSERT INTO dispute_resolutions
              (dispute_id, decision, reasoning, resolved_by_admin_user_id, resolved_at,
               proposed_refund_amount_minor_units, proposed_refund_currency_code,
               idempotency_key, idempotency_fingerprint)
            VALUES (${disputeId}, ${input.decision}, ${input.reasoning}, ${adminUserId}, clock_timestamp(),
                    ${input.proposedRefundAmountMinorUnits}, ${input.proposedRefundCurrencyCode},
                    ${idempotency.key}, ${idempotency.fingerprint})`,
      );

      const moved = await queryRows<{ id: string }>(
        tx,
        sql`UPDATE disputes SET status = 'resolved', updated_at = clock_timestamp(), version = version + 1
             WHERE id = ${disputeId} AND status IN ('open','under_review')
             RETURNING id`,
      );
      if (moved.length === 0) throw disputeAlreadyResolvedError();
    });
  } catch (err) {
    // The unique index is the real authority: double resolution is impossible at the database.
    if (isUniqueViolation(err, 'dispute_resolutions_dispute_uq')) throw disputeAlreadyResolvedError();
    throw err;
  }

  await auditDispute({
    actorUserId: adminUserId,
    eventType: DISPUTE_EVENT_TYPES.resolved,
    targetId: disputeId,
    reason: input.reasoning,
    correlationId,
    details: {
      decision: input.decision,
      proposedRefundAmountMinorUnits: input.proposedRefundAmountMinorUnits,
      proposedRefundCurrencyCode: input.proposedRefundCurrencyCode,
    },
  });

  await emitToBothParties('dispute_resolved', disputeId, {
    customerUserId: ownership.customerUserId,
    providerUserId: ownership.providerUserId,
  });

  // Advisory refresh (AC-6), after commit and incapable of affecting anything decided above.
  // It summarizes the REASONING plus the evidence descriptors, so the queue shows an up-to-date
  // brief for a case that has now been decided. Nothing reads the result back.
  const summary = await summarizeForTriage({
    reason: input.reasoning,
    evidence: await evidenceDescriptors(disputeId),
  });
  if (summary !== null) {
    await db.execute(sql`UPDATE disputes SET ai_summary = ${summary}, updated_at = clock_timestamp() WHERE id = ${disputeId}`);
  }

  const row = await loadResolutionRow(db, disputeId);
  if (!row) throw disputeNotFoundError();
  return toResolutionDto(row, await resolveRefundState(db, row));
}

/**
 * DECIDED-5 step 2 — records the `adminActionId` spec 022's `POST /api/v1/admin/refunds` returned.
 *
 * Added during review (DECIDED-11): without it the proposal could never be tied to the refund that
 * satisfies it, and `refundState` could never leave `proposed`.
 *
 * The conditional `WHERE refund_admin_action_id IS NULL` is what makes a duplicate refund request
 * impossible: a resolution is linked to at most one approval chain, so a second Finance admin
 * initiating a second override cannot attach it to the same dispute.
 */
export async function linkRefundApproval(
  disputeId: string,
  adminUserId: string,
  input: ParsedLinkRefund,
  correlationId: string | null,
): Promise<DisputeResolutionDto> {
  await resolveAdminAccess(disputeId, adminUserId, requireDisputeResolvePermission);
  const db = getDb();

  const resolution = await loadResolutionRow(db, disputeId);
  if (!resolution) throw disputeNotFoundError();
  if (resolution.proposed_refund_amount_minor_units === null) {
    throw disputeRefundAmountInvalidError('this resolution did not propose a refund');
  }
  if (resolution.refund_admin_action_id) {
    if (resolution.refund_admin_action_id === input.adminActionId) {
      return toResolutionDto(resolution, await resolveRefundState(db, resolution));
    }
    throw disputeRefundAlreadyLinkedError();
  }

  const [action] = await queryRows<{ id: string }>(
    db,
    sql`SELECT id FROM admin_actions WHERE id = ${input.adminActionId}`,
  );
  if (!action) throw disputeRefundAmountInvalidError('that admin action does not exist');

  const updated = await queryRows<{ id: string }>(
    db,
    sql`UPDATE dispute_resolutions
           SET refund_admin_action_id = ${input.adminActionId}, updated_at = clock_timestamp(), version = version + 1
         WHERE dispute_id = ${disputeId} AND refund_admin_action_id IS NULL
         RETURNING id`,
  );
  if (updated.length === 0) throw disputeRefundAlreadyLinkedError();

  await auditDispute({
    actorUserId: adminUserId,
    eventType: DISPUTE_EVENT_TYPES.refundLinked,
    targetId: disputeId,
    correlationId,
    details: { adminActionId: input.adminActionId },
  });

  const row = await loadResolutionRow(db, disputeId);
  return toResolutionDto(row!, await resolveRefundState(db, row!));
}

/** DECIDED-6 — sets or clears the legal hold. Reason mandatory, always audited. */
export async function setLegalHold(
  disputeId: string,
  adminUserId: string,
  input: ParsedLegalHold,
  correlationId: string | null,
): Promise<AdminDisputeDto> {
  await resolveAdminAccess(disputeId, adminUserId, requireDisputeResolvePermission);

  await getDb().execute(
    sql`UPDATE disputes SET legal_hold = ${input.legalHold}, updated_at = clock_timestamp(), version = version + 1
         WHERE id = ${disputeId}`,
  );

  if (input.legalHold) {
    const { holdEvidenceFor } = await import('./evidence');
    await holdEvidenceFor(disputeId);
  }

  await auditDispute({
    actorUserId: adminUserId,
    eventType: input.legalHold ? DISPUTE_EVENT_TYPES.legalHoldSet : DISPUTE_EVENT_TYPES.legalHoldCleared,
    targetId: disputeId,
    reason: input.reason,
    correlationId,
  });

  return getDisputeForAdmin(disputeId, adminUserId, correlationId, requireDisputeResolvePermission);
}
