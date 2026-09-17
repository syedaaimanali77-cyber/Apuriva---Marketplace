/**
 * Spec 028 §3 "Milestones" (AC-3, AC-10) — the provider's optional progress updates.
 *
 * MILESTONES ARE CONTENT, NEVER CONTROL. This module deliberately does not import
 * `applyBookingTransition`, does not read or write `bookings.status` except to decide whether a
 * milestone may be posted at all, and writes nothing to `bookings_status_history`. A booking may go
 * `confirmed -> ... -> completed` with zero milestones and nothing anywhere behaves differently;
 * `execution-boundary.test.ts` asserts this at the source level, the same technique
 * `payment-boundary.test.ts` uses for the spec 020/021 boundary.
 *
 * Append-only: there is no update and no delete path. A posted milestone is part of what the
 * customer was told during the job, so it is not revisable after the fact.
 */
import { sql } from 'drizzle-orm';
import { validationError } from '@/lib/api/errors';
import { getDb } from '@/lib/db';
import { BOOKING_MILESTONE_TYPES } from '@/lib/db/schema';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import type {
  BookingMilestoneDto,
  BookingMilestoneType,
  CreateBookingMilestoneRequest,
} from '@/lib/types/bookings';
import { bookingNotFoundError, idempotencyKeyConflictError, milestoneNotAllowedInStatusError } from './errors';
import { EXECUTING_BOOKING_STATUSES, isExecutingStatus } from './execution-window';
import { requireBookingParticipant } from './read';

/** §4 C-2 — a milestone note is bounded at the database; the same bound is checked here first. */
export const MAX_MILESTONE_NOTE_LENGTH = 500;

/**
 * The statuses during which a milestone may be posted. Identical to the evidence-upload window on
 * purpose: both mean "the job is happening right now", and naming it once keeps them that way.
 */
export const MILESTONE_POSTABLE_STATUSES = EXECUTING_BOOKING_STATUSES;

interface MilestoneRow {
  id: string;
  booking_id: string;
  milestone_type: BookingMilestoneType;
  note: string | null;
  created_at: Date | string;
}

function toDto(row: MilestoneRow): BookingMilestoneDto {
  return {
    id: row.id,
    bookingId: row.booking_id,
    milestoneType: row.milestone_type,
    note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const MILESTONE_COLUMNS = sql`id, booking_id, milestone_type, note, created_at`;

/**
 * Parses and validates the request body. A `custom` milestone MUST carry a note — an unlabelled
 * custom milestone would be a row that says nothing — and every other type may carry one.
 *
 * Returns the canonical shape, so the idempotency fingerprint is taken over normalized values and
 * a retry that differs only in whitespace is recognized as the same request.
 */
export function parseMilestoneRequest(body: unknown): { milestoneType: BookingMilestoneType; note: string | null } {
  const input = (body ?? {}) as Partial<CreateBookingMilestoneRequest>;
  const errors: { field: string; message: string }[] = [];

  const milestoneType = input.milestoneType;
  if (!isMilestoneType(milestoneType)) {
    errors.push({ field: 'milestoneType', message: `must be one of ${BOOKING_MILESTONE_TYPES.join(', ')}` });
  }

  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') {
      errors.push({ field: 'note', message: 'must be a string' });
    } else {
      note = input.note.trim();
      if (note.length === 0) note = null;
      else if (note.length > MAX_MILESTONE_NOTE_LENGTH) {
        errors.push({ field: 'note', message: `must be at most ${MAX_MILESTONE_NOTE_LENGTH} characters` });
      }
    }
  }

  if (milestoneType === 'custom' && note === null) {
    errors.push({ field: 'note', message: 'is required for a custom milestone' });
  }

  if (errors.length > 0) throw validationError(errors);
  return { milestoneType: milestoneType as BookingMilestoneType, note };
}

export function isMilestoneType(value: unknown): value is BookingMilestoneType {
  return typeof value === 'string' && (BOOKING_MILESTONE_TYPES as readonly string[]).includes(value);
}

/**
 * Posts one milestone on behalf of the booking's provider.
 *
 * AC-10's idempotency is enforced by the database, not by a read-then-write: the insert carries the
 * key and `booking_milestones_booking_idempotency_key_uq` decides the race. Two concurrent retries
 * therefore produce exactly one row — a prior `SELECT` could not promise that.
 *
 * A replay with the SAME fingerprint returns the original row (`replayed: true`, `200`); the same
 * key with a DIFFERENT body is `409 IDEMPOTENCY_KEY_CONFLICT` and writes nothing.
 */
export async function createBookingMilestone(
  userId: string,
  providerProfileId: string,
  bookingId: string,
  input: { milestoneType: BookingMilestoneType; note: string | null },
  idempotency: { key: string; fingerprint: string },
): Promise<{ milestone: BookingMilestoneDto; replayed: boolean }> {
  // Participation, resolved server-side. `preferRole: 'provider'` means a customer calling this
  // gets `404`, indistinguishable from a booking that does not exist (spec 020's rule).
  const { booking } = await requireBookingParticipant(userId, bookingId, 'provider');

  // The provider id comes from `requireOwnProviderProfile` in the route and must match the
  // booking's own provider. Belt and braces: participation already proved it, and this catches any
  // future caller that passes a profile id from somewhere less trustworthy.
  if (booking.providerProfileId !== providerProfileId) throw bookingNotFoundError();

  if (!isExecutingStatus(booking.status)) throw milestoneNotAllowedInStatusError(booking.status);

  try {
    const [row] = await queryRows<MilestoneRow>(
      getDb(),
      sql`INSERT INTO booking_milestones
            (booking_id, milestone_type, note, created_by_user_id, idempotency_key, idempotency_fingerprint)
          VALUES (${bookingId}, ${input.milestoneType}, ${input.note}, ${userId},
                  ${idempotency.key}, ${idempotency.fingerprint})
          RETURNING ${MILESTONE_COLUMNS}`,
    );
    return { milestone: toDto(row!), replayed: false };
  } catch (err) {
    if (!isUniqueViolation(err, 'booking_milestones_booking_idempotency_key_uq')) throw err;

    const existing = await findByIdempotencyKey(bookingId, idempotency.key);
    // Gone between the conflict and the read: nothing to replay, so surface the conflict.
    if (!existing) throw idempotencyKeyConflictError();
    if (existing.fingerprint !== idempotency.fingerprint) throw idempotencyKeyConflictError();
    return { milestone: existing.milestone, replayed: true };
  }
}

async function findByIdempotencyKey(
  bookingId: string,
  key: string,
): Promise<{ milestone: BookingMilestoneDto; fingerprint: string } | null> {
  const [row] = await queryRows<MilestoneRow & { idempotency_fingerprint: string }>(
    getDb(),
    sql`SELECT ${MILESTONE_COLUMNS}, idempotency_fingerprint
          FROM booking_milestones
         WHERE booking_id = ${bookingId} AND idempotency_key = ${key}`,
  );
  return row ? { milestone: toDto(row), fingerprint: row.idempotency_fingerprint } : null;
}

/** Both participants, either mode — a milestone exists to be seen by the customer (AC-3). */
export async function listBookingMilestones(
  userId: string,
  bookingId: string,
  tx?: Executor,
): Promise<BookingMilestoneDto[]> {
  await requireBookingParticipant(userId, bookingId);

  const rows = await queryRows<MilestoneRow>(
    tx ?? getDb(),
    sql`SELECT ${MILESTONE_COLUMNS} FROM booking_milestones
         WHERE booking_id = ${bookingId}
         ORDER BY created_at ASC, id ASC`,
  );
  return rows.map(toDto);
}
