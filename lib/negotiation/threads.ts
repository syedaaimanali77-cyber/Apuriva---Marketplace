/**
 * Spec 019 §3 — building blocks shared by messages and change requests: row mapping, idempotency lookup,
 * thread visibility, AC-8 closure, the database-enforced anti-spam window (AC-1) and the insert.
 *
 * A thread is the (request, provider) pair. The per-thread lock is the `request_provider_matches` row, so
 * the anti-spam count and the insert are serialized per thread across processes.
 */
import { sql } from 'drizzle-orm';
import { rateLimitedError } from '@/lib/api/errors';
import { queryRows, type Executor } from '@/lib/offers/db';
import type { NegotiationSenderRole, OfferMessageDto, OfferMessageKind } from '@/lib/types/negotiation';
import { redactContactInfo } from './contact-redaction';
import { OPEN_THREAD_REQUEST_STATUSES, STORED_BODY_MAX_LENGTH, THREAD_MESSAGE_LIMIT, THREAD_MESSAGE_WINDOW_SQL } from './limits';

export interface OfferMessageRow {
  id: string;
  request_id: string;
  provider_profile_id: string;
  offer_id: string | null;
  kind: OfferMessageKind;
  sender_role: NegotiationSenderRole;
  body: string;
  contact_redacted: boolean;
  proposed_price_amount_minor_units: number | null;
  proposed_price_currency_code: string | null;
  created_at: Date;
}

export const MESSAGE_COLUMNS = sql`
  id, request_id, provider_profile_id, offer_id, kind, sender_role, body, contact_redacted,
  proposed_price_amount_minor_units, proposed_price_currency_code, created_at
`;

/** Never serializes `sender_user_id`, idempotency keys or fingerprints. */
export function toOfferMessageDto(row: OfferMessageRow): OfferMessageDto {
  return {
    id: row.id,
    requestId: row.request_id,
    providerProfileId: row.provider_profile_id,
    offerId: row.offer_id,
    kind: row.kind,
    senderRole: row.sender_role,
    body: row.body,
    contactRedacted: row.contact_redacted,
    proposedPrice:
      row.proposed_price_amount_minor_units !== null && row.proposed_price_currency_code !== null
        ? { amountMinorUnits: row.proposed_price_amount_minor_units, currencyCode: row.proposed_price_currency_code }
        : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function loadMessageDto(db: Executor, messageId: string): Promise<OfferMessageDto> {
  const [row] = await queryRows<OfferMessageRow>(db, sql`SELECT ${MESSAGE_COLUMNS} FROM offer_messages WHERE id = ${messageId}`);
  return toOfferMessageDto(row!);
}

export type MessageIdempotencyHit = { kind: 'replay'; messageId: string } | { kind: 'conflict' } | null;

/** Message/change-request keys are scoped per sender (`offer_messages_sender_idempotency_key_uq`). */
export async function findMessageByIdempotencyKey(
  db: Executor,
  senderUserId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<MessageIdempotencyHit> {
  const [row] = await queryRows<{ id: string; idempotency_fingerprint: string }>(
    db,
    sql`SELECT id, idempotency_fingerprint FROM offer_messages
         WHERE sender_user_id = ${senderUserId} AND idempotency_key = ${idempotencyKey}`,
  );
  if (!row) return null;
  return row.idempotency_fingerprint === fingerprint ? { kind: 'replay', messageId: row.id } : { kind: 'conflict' };
}

/**
 * Customer visibility (§3 "Messages" step 3): the provider has a non-draft offer on the request, or has
 * already posted in the thread. The customer never sees spec 017's distribution pool otherwise.
 */
export async function customerCanSeeThread(db: Executor, requestId: string, providerProfileId: string): Promise<boolean> {
  const [row] = await queryRows<{ visible: boolean }>(
    db,
    sql`SELECT (
          EXISTS (SELECT 1 FROM offers WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId} AND status <> 'draft')
          OR EXISTS (SELECT 1 FROM offer_messages WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId} AND sender_role = 'provider')
        ) AS visible`,
  );
  return Boolean(row?.visible);
}

export interface ClosureInputs {
  requestStatus: string;
  providerResponse: string | null;
  hasDeclinedOffer: boolean;
}

/** AC-8 — pure: a thread is read-only once any of these holds. */
export function isThreadClosed(inputs: ClosureInputs): boolean {
  return (
    !(OPEN_THREAD_REQUEST_STATUSES as readonly string[]).includes(inputs.requestStatus) ||
    inputs.providerResponse === 'declined' ||
    inputs.hasDeclinedOffer
  );
}

export async function loadClosureInputs(db: Executor, requestId: string, providerProfileId: string): Promise<ClosureInputs | null> {
  const [row] = await queryRows<{ status: string; provider_response: string | null; declined: boolean }>(
    db,
    sql`SELECT r.status, m.provider_response,
               EXISTS (SELECT 1 FROM offers WHERE request_id = r.id AND provider_profile_id = ${providerProfileId} AND status = 'declined') AS declined
          FROM requests r
          LEFT JOIN request_provider_matches m ON m.request_id = r.id AND m.provider_profile_id = ${providerProfileId}
         WHERE r.id = ${requestId}`,
  );
  if (!row) return null;
  return { requestStatus: row.status, providerResponse: row.provider_response, hasDeclinedOffer: row.declined };
}

/**
 * AC-1 anti-spam — at most `THREAD_MESSAGE_LIMIT` rows per sender per thread in a rolling window, counted
 * by the DATABASE clock. Must run while the thread lock is held. Throws `429` with a database-computed
 * `Retry-After`; nothing is written.
 */
export async function assertWithinThreadLimit(
  tx: Executor,
  senderUserId: string,
  requestId: string,
  providerProfileId: string,
): Promise<void> {
  const [row] = await queryRows<{ n: number; retry_after: number | null }>(
    tx,
    sql`SELECT count(*)::int AS n,
               GREATEST(1, CEIL(EXTRACT(EPOCH FROM (min(created_at) + ${THREAD_MESSAGE_WINDOW_SQL} - clock_timestamp()))))::int AS retry_after
          FROM offer_messages
         WHERE sender_user_id = ${senderUserId} AND request_id = ${requestId} AND provider_profile_id = ${providerProfileId}
           AND created_at > clock_timestamp() - ${THREAD_MESSAGE_WINDOW_SQL}`,
  );
  if ((row?.n ?? 0) >= THREAD_MESSAGE_LIMIT) {
    console.log(JSON.stringify({ event: 'negotiation.thread_rate_limited', requestId, providerProfileId }));
    throw rateLimitedError(row?.retry_after ?? 1);
  }
}

/** Redacts before storage; the stored text is bounded by `offer_messages_body_length_ck`. */
export function prepareStoredText(input: string): { text: string; redacted: boolean } {
  const { text, redacted } = redactContactInfo(input);
  return { text: text.length > STORED_BODY_MAX_LENGTH ? text.slice(0, STORED_BODY_MAX_LENGTH) : text, redacted };
}

export async function insertThreadRow(
  tx: Executor,
  args: {
    requestId: string;
    providerProfileId: string;
    offerId: string | null;
    senderUserId: string;
    senderRole: NegotiationSenderRole;
    kind: OfferMessageKind;
    body: string;
    contactRedacted: boolean;
    proposedPrice: { amountMinorUnits: number; currencyCode: string } | null;
    idempotencyKey: string;
    fingerprint: string;
  },
): Promise<string> {
  const [row] = await queryRows<{ id: string }>(
    tx,
    sql`INSERT INTO offer_messages
          (request_id, provider_profile_id, offer_id, sender_user_id, sender_role, kind, body, contact_redacted,
           proposed_price_amount_minor_units, proposed_price_currency_code, idempotency_key, idempotency_fingerprint,
           created_at, updated_at)
        VALUES (${args.requestId}, ${args.providerProfileId}, ${args.offerId}, ${args.senderUserId}, ${args.senderRole},
                ${args.kind}, ${args.body}, ${args.contactRedacted},
                ${args.proposedPrice?.amountMinorUnits ?? null}, ${args.proposedPrice?.currencyCode ?? null},
                ${args.idempotencyKey}, ${args.fingerprint}, clock_timestamp(), clock_timestamp())
        RETURNING id`,
  );
  return row!.id;
}
