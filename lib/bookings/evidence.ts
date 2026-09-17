/**
 * Spec 028 §3 "Completion-evidence resolution" (AC-4, AC-5, AC-6, AC-8).
 *
 * This module is the whole of the completion-evidence rule, and it is built on exactly two things
 * that already shipped: spec 020's `CompletionEvidenceGate` port and spec 027's `file_assets`.
 * It creates no storage, no second file lifecycle and no transition.
 *
 * THE INVARIANT THIS MODULE EXISTS TO HOLD (AC-4/AC-6): a provider cannot talk their way past a
 * completion-evidence requirement.
 *
 *   - The REQUIREMENT is read only from `services.completion_evidence_required`, joined through
 *     `bookings.service_id`. The only client-supplied value anywhere on the path is the booking id
 *     in the URL, which spec 020 has already authorized. There is no "skip evidence" input.
 *   - SATISFACTION is a `count(*)` over live `ready` assets whose `context_id` IS this booking.
 *     Another booking's asset, another provider's asset, a `pending`/`scanning`/`rejected` asset
 *     and a soft-deleted one are all excluded, and the upload policy (`evidence-policy.ts`) means
 *     such a row can only ever have been created by this booking's own provider.
 *   - `evidenceFileAssetIds` CANNOT WIDEN EITHER. It is validated against the identical predicate
 *     and is never an input to the count, so it can only cause a request to fail that would
 *     otherwise have succeeded.
 *
 * Both functions run inside spec 020's already-locked completion transaction, so the answer cannot
 * change between the check and the transition, and each concurrent caller is judged on its own
 * merits (spec 020 AC-9 / spec 028 AC-11).
 */
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { queryRows, type Executor } from '@/lib/offers/db';
import { isUuid } from '@/lib/offers/validation';
import { FILE_ASSET_COLUMNS, toFileAssetDto, type FileAssetRow } from '@/lib/files/assets';
import type { FileAssetDto } from '@/lib/types/files';
import type { CompletionEvidenceGate, CompletionEvidenceStatus } from './completion-evidence';
import { evidenceAssetInvalidError } from './errors';
import { requireBookingParticipant } from './read';

/** How many `ready` evidence assets an evidence-requiring booking needs. Platform-wide (§8 #3). */
export const MIN_COMPLETION_EVIDENCE_ASSETS = 1;

/** The per-booking cap spec 027's registry enforces at `upload-url` time. */
export const MAX_BOOKING_EVIDENCE_ASSETS = 10;

/** Spec 027's reserved `context_type` for this spec. Named once so no query spells it by hand. */
export const BOOKING_EVIDENCE_CONTEXT = 'booking_evidence';

/**
 * The predicate that defines "valid completion evidence for booking X", written once and reused by
 * the gate, the id validator and the read surface — so the three can never drift apart.
 */
function evidenceFor(booking: SQL | string) {
  const bookingRef = typeof booking === 'string' ? sql`${booking}` : booking;
  return sql`fa.context_type = ${BOOKING_EVIDENCE_CONTEXT}
         AND fa.context_id = ${bookingRef}
         AND fa.status = 'ready'
         AND fa.deleted_at IS NULL`;
}

/**
 * The real gate registered with spec 020's `registerCompletionEvidenceGate()` (§9 "Migration
 * order"). Until this is registered, spec 020's inert default applies and nothing requires
 * evidence — which is its documented pre-028 behaviour, not a stub.
 */
export const completionEvidenceGate: CompletionEvidenceGate = async (
  tx: Executor,
  bookingId: string,
): Promise<CompletionEvidenceStatus> => {
  const [row] = await queryRows<{ required: boolean; ready_count: number }>(
    tx,
    sql`SELECT s.completion_evidence_required AS required,
               (SELECT count(*) FROM file_assets fa WHERE ${evidenceFor(sql`b.id`)})::int AS ready_count
          FROM bookings b
          JOIN services s ON s.id = b.service_id
         WHERE b.id = ${bookingId}`,
  );

  // A booking that vanished mid-transaction cannot be completed anyway; spec 020's own status
  // re-check under the lock rejects it. Reporting "no requirement" here would be a silent bypass,
  // so an absent row reports the requirement UNMET rather than absent.
  if (!row) return { required: true, satisfied: false };
  if (!row.required) return { required: false, satisfied: true };
  return { required: true, satisfied: row.ready_count >= MIN_COMPLETION_EVIDENCE_ASSETS };
};

/**
 * AC-6 — every id the caller listed must be valid completion evidence for THIS booking.
 *
 * Runs immediately before the gate, inside the same lock, and therefore before spec 020's
 * already-`completed` short circuit: a caller who sends a foreign id is rejected on its own merits
 * even when the other party's concurrent request has already completed the booking (AC-11).
 *
 * Duplicates in the list are collapsed before counting, so repeating one valid id is not mistaken
 * for a missing one.
 */
export async function assertEvidenceAssetsBelongToBooking(
  tx: Executor,
  bookingId: string,
  fileAssetIds: readonly string[] | undefined,
): Promise<void> {
  if (!fileAssetIds || fileAssetIds.length === 0) return;

  const unique = [...new Set(fileAssetIds)];

  // A malformed id never reaches the database: it is simply not valid evidence.
  const malformed = unique.filter((id) => typeof id !== 'string' || !isUuid(id));
  if (malformed.length > 0) throw evidenceAssetInvalidError(malformed);

  const rows = await queryRows<{ id: string }>(
    tx,
    sql`SELECT fa.id FROM file_assets fa
         WHERE fa.id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
           AND fa.context_type = ${BOOKING_EVIDENCE_CONTEXT}
           AND fa.context_id = ${bookingId}
           AND fa.status = 'ready'
           AND fa.deleted_at IS NULL`,
  );

  const found = new Set(rows.map((row) => row.id));
  const invalid = unique.filter((id) => !found.has(id));
  if (invalid.length > 0) throw evidenceAssetInvalidError(invalid);
}

/**
 * AC-8 — the booking's evidence, as metadata only.
 *
 * The PROVIDER sees it at any time. The CUSTOMER sees it only once the booking has actually reached
 * `completed`; before that they get an empty list, never a `403`, because the existence of evidence
 * is itself information about a job still in progress.
 *
 * "Has reached completed" is read from `bookings_status_history`, not from the current status: a
 * booking that completed and later became `disputed` or `refunded` has still been completed, and a
 * booking that was cancelled without ever completing has not.
 *
 * Bytes are NEVER served from here. A client fetches each asset through spec 027's
 * `GET /api/v1/files/{id}`, which re-runs `canRead` on every URL issue and every content fetch —
 * so even a leaked id cannot be turned into a download, and this route can never become a second,
 * weaker read path.
 */
export async function listBookingEvidence(userId: string, bookingId: string): Promise<FileAssetDto[]> {
  const { isProvider } = await requireBookingParticipant(userId, bookingId);

  if (!isProvider && !(await hasReachedCompleted(bookingId))) return [];

  const rows = await queryRows<FileAssetRow>(
    getDb(),
    sql`SELECT ${FILE_ASSET_COLUMNS} FROM file_assets fa
         WHERE ${evidenceFor(bookingId)}
         ORDER BY fa.created_at ASC, fa.id ASC`,
  );
  return rows.map(toFileAssetDto);
}

/** Whether this booking has ever been marked `completed`. */
export async function hasReachedCompleted(bookingId: string, tx?: Executor): Promise<boolean> {
  const [row] = await queryRows<{ reached: boolean }>(
    tx ?? getDb(),
    sql`SELECT EXISTS (
           SELECT 1 FROM bookings_status_history
            WHERE booking_id = ${bookingId} AND to_status = 'completed'
         ) AS reached`,
  );
  return Boolean(row?.reached);
}
