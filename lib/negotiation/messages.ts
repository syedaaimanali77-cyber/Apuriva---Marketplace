/**
 * Spec 019 §3 "Messages — rules in evaluation order" (AC-1, AC-7, AC-8) and the thread reads.
 *
 * Lock order: `requests` FOR SHARE, then the thread's `request_provider_matches` row FOR UPDATE. The share
 * lock conflicts with accept's `FOR UPDATE`, so no message commits after a concurrent selection; every
 * other writer that touches both rows takes the request first too, so no deadlock is possible.
 */
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { idempotencyFingerprint } from '@/lib/api/idempotency';
import { buildPage, type PageParams } from '@/lib/api/pagination';
import { isUniqueViolation, queryRows, type Executor } from '@/lib/offers/db';
import { assertCustomerOwnsRequest } from '@/lib/offers/read';
import { effectiveStatus } from '@/lib/offers/timer';
import { isUuid } from '@/lib/offers/validation';
import type { OfferStatus } from '@/lib/types/offers';
import type { MessageThreadSummaryDto, NegotiationSenderRole, OfferMessageDto } from '@/lib/types/negotiation';
import { idempotencyKeyConflictError, notDistributedToProviderError, threadClosedError, threadNotFoundError } from './errors';
import { logContactRedaction } from './redaction-log';
import {
  assertWithinThreadLimit,
  customerCanSeeThread,
  findMessageByIdempotencyKey,
  insertThreadRow,
  isThreadClosed,
  loadClosureInputs,
  loadMessageDto,
  MESSAGE_COLUMNS,
  prepareStoredText,
  toOfferMessageDto,
  type OfferMessageRow,
} from './threads';
import { validateMessageBody } from './validation';

type Paged<T> = { data: T[]; page: ReturnType<typeof buildPage> };

async function assertProviderDistributed(db: Executor, providerProfileId: string, requestId: string): Promise<void> {
  if (!isUuid(requestId)) throw notDistributedToProviderError();
  const [row] = await queryRows<{ id: string }>(
    db,
    sql`SELECT id FROM request_provider_matches
         WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId} AND notified_at IS NOT NULL`,
  );
  if (!row) throw notDistributedToProviderError();
}

async function assertCustomerThread(customerUserId: string, requestId: string, providerProfileId: string): Promise<void> {
  await assertCustomerOwnsRequest(customerUserId, requestId);
  if (!isUuid(providerProfileId) || !(await customerCanSeeThread(getDb(), requestId, providerProfileId))) {
    throw threadNotFoundError();
  }
}

async function postMessage(args: {
  senderUserId: string;
  senderRole: NegotiationSenderRole;
  requestId: string;
  providerProfileId: string;
  idempotencyKey: string;
  body: unknown;
  authorize: () => Promise<void>;
}): Promise<{ message: OfferMessageDto; replayed: boolean }> {
  const { senderUserId, requestId, providerProfileId, idempotencyKey } = args;

  // Step 1 — idempotency.
  const fingerprint = idempotencyFingerprint({ requestId, providerProfileId, body: args.body });
  const early = await findMessageByIdempotencyKey(getDb(), senderUserId, idempotencyKey, fingerprint);
  if (early?.kind === 'conflict') throw idempotencyKeyConflictError();
  if (early?.kind === 'replay') return { message: await loadMessageDto(getDb(), early.messageId), replayed: true };

  // Step 2 — validation (length on the input, before redaction).
  const input = validateMessageBody(args.body);
  // Step 3 — authorization.
  await args.authorize();

  const stored = prepareStoredText(input);
  let outcome: { messageId: string; replayed: boolean };
  try {
    outcome = await getDb().transaction(async (tx) => {
      // Step 4 — locks: request (share), then the thread row.
      await tx.execute(sql`SELECT id FROM requests WHERE id = ${requestId} FOR SHARE`);
      const [thread] = await queryRows<{ id: string }>(
        tx,
        sql`SELECT id FROM request_provider_matches WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId} FOR UPDATE`,
      );
      if (!thread) throw args.senderRole === 'customer' ? threadNotFoundError() : notDistributedToProviderError();

      const locked = await findMessageByIdempotencyKey(tx, senderUserId, idempotencyKey, fingerprint);
      if (locked?.kind === 'conflict') throw idempotencyKeyConflictError();
      if (locked?.kind === 'replay') return { messageId: locked.messageId, replayed: true };

      // Step 5 — AC-8 closure.
      const closure = await loadClosureInputs(tx, requestId, providerProfileId);
      if (!closure || isThreadClosed(closure)) throw threadClosedError();

      // Step 6 — AC-1 anti-spam.
      await assertWithinThreadLimit(tx, senderUserId, requestId, providerProfileId);

      // Step 7 — insert the redacted text.
      const messageId = await insertThreadRow(tx, {
        requestId,
        providerProfileId,
        offerId: null,
        senderUserId,
        senderRole: args.senderRole,
        kind: 'message',
        body: stored.text,
        contactRedacted: stored.redacted,
        proposedPrice: null,
        idempotencyKey,
        fingerprint,
      });
      return { messageId, replayed: false };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'offer_messages_sender_idempotency_key_uq')) {
      const hit = await findMessageByIdempotencyKey(getDb(), senderUserId, idempotencyKey, fingerprint);
      if (hit?.kind === 'replay') return { message: await loadMessageDto(getDb(), hit.messageId), replayed: true };
      throw idempotencyKeyConflictError();
    }
    throw err;
  }

  if (!outcome.replayed) {
    console.log(JSON.stringify({ event: 'negotiation.message_sent', requestId, providerProfileId, senderRole: args.senderRole }));
    if (stored.redacted) await logContactRedaction(senderUserId, requestId, 'body');
  }
  return { message: await loadMessageDto(getDb(), outcome.messageId), replayed: outcome.replayed };
}

/** `POST /api/v1/requests/{id}/message-threads/{providerProfileId}/messages`. */
export function sendCustomerMessage(
  customerUserId: string,
  requestId: string,
  providerProfileId: string,
  idempotencyKey: string,
  body: unknown,
): Promise<{ message: OfferMessageDto; replayed: boolean }> {
  return postMessage({
    senderUserId: customerUserId,
    senderRole: 'customer',
    requestId,
    providerProfileId,
    idempotencyKey,
    body,
    authorize: () => assertCustomerThread(customerUserId, requestId, providerProfileId),
  });
}

/** `POST /api/v1/providers/me/requests/{id}/messages` — a distributed provider may ask before offering. */
export function sendProviderMessage(
  providerUserId: string,
  providerProfileId: string,
  requestId: string,
  idempotencyKey: string,
  body: unknown,
): Promise<{ message: OfferMessageDto; replayed: boolean }> {
  return postMessage({
    senderUserId: providerUserId,
    senderRole: 'provider',
    requestId,
    providerProfileId,
    idempotencyKey,
    body,
    authorize: () => assertProviderDistributed(getDb(), providerProfileId, requestId),
  });
}

async function listThread(requestId: string, providerProfileId: string, page: PageParams): Promise<Paged<OfferMessageDto>> {
  const db = getDb();
  const [{ total } = { total: 0 }] = await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM offer_messages WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId}`,
  );
  const rows = await queryRows<OfferMessageRow>(
    db,
    sql`SELECT ${MESSAGE_COLUMNS} FROM offer_messages
         WHERE request_id = ${requestId} AND provider_profile_id = ${providerProfileId}
         ORDER BY created_at ASC, id ASC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );
  return { data: rows.map(toOfferMessageDto), page: buildPage(Number(total), page.limit, page.offset) };
}

/** Closed threads stay readable to both parties (AC-8). */
export async function listCustomerThreadMessages(
  customerUserId: string,
  requestId: string,
  providerProfileId: string,
  page: PageParams,
): Promise<Paged<OfferMessageDto>> {
  await assertCustomerThread(customerUserId, requestId, providerProfileId);
  return listThread(requestId, providerProfileId, page);
}

export async function listProviderThreadMessages(
  providerProfileId: string,
  requestId: string,
  page: PageParams,
): Promise<Paged<OfferMessageDto>> {
  await assertProviderDistributed(getDb(), providerProfileId, requestId);
  return listThread(requestId, providerProfileId, page);
}

interface ThreadSummaryRow {
  provider_profile_id: string;
  business_name: string | null;
  head_id: string | null;
  head_status: OfferStatus | null;
  head_expires_at: Date | null;
  message_count: number;
  last_message_at: Date | null;
  provider_response: string | null;
  declined: boolean;
  request_status: string;
  server_now: Date;
}

/** `GET /api/v1/requests/{id}/message-threads` — only threads the customer may see (§3 step 3). */
export async function listCustomerThreads(customerUserId: string, requestId: string, page: PageParams): Promise<Paged<MessageThreadSummaryDto>> {
  await assertCustomerOwnsRequest(customerUserId, requestId);
  const db = getDb();

  const visibleProviders = sql`
    SELECT provider_profile_id FROM offers WHERE request_id = ${requestId} AND status <> 'draft'
    UNION
    SELECT provider_profile_id FROM offer_messages WHERE request_id = ${requestId} AND sender_role = 'provider'
  `;
  const [{ total } = { total: 0 }] = await queryRows<{ total: number }>(
    db,
    sql`SELECT count(*)::int AS total FROM (${visibleProviders}) v`,
  );
  const rows = await queryRows<ThreadSummaryRow>(
    db,
    sql`WITH visible AS (${visibleProviders}),
        heads AS (
          SELECT DISTINCT ON (provider_profile_id) provider_profile_id, id, status, expires_at, sent_at
            FROM offers WHERE request_id = ${requestId} AND status <> 'draft'
           ORDER BY provider_profile_id, sent_at DESC, id DESC
        ),
        msgs AS (
          SELECT provider_profile_id, count(*)::int AS n, max(created_at) AS last_at
            FROM offer_messages WHERE request_id = ${requestId} GROUP BY provider_profile_id
        )
        SELECT v.provider_profile_id, pp.business_name, h.id AS head_id, h.status AS head_status,
               h.expires_at AS head_expires_at, coalesce(m.n, 0) AS message_count, m.last_at AS last_message_at,
               rpm.provider_response,
               EXISTS (SELECT 1 FROM offers d WHERE d.request_id = ${requestId}
                         AND d.provider_profile_id = v.provider_profile_id AND d.status = 'declined') AS declined,
               r.status AS request_status, clock_timestamp() AS server_now
          FROM visible v
          JOIN provider_profiles pp ON pp.id = v.provider_profile_id
          JOIN requests r ON r.id = ${requestId}
          LEFT JOIN heads h ON h.provider_profile_id = v.provider_profile_id
          LEFT JOIN msgs m ON m.provider_profile_id = v.provider_profile_id
          LEFT JOIN request_provider_matches rpm ON rpm.request_id = ${requestId} AND rpm.provider_profile_id = v.provider_profile_id
         ORDER BY GREATEST(m.last_at, h.sent_at) DESC NULLS LAST, v.provider_profile_id ASC
         LIMIT ${page.limit} OFFSET ${page.offset}`,
  );

  const data = rows.map((row): MessageThreadSummaryDto => {
    const now = new Date(row.server_now);
    return {
      providerProfileId: row.provider_profile_id,
      providerBusinessName: row.business_name,
      headOffer:
        row.head_id && row.head_status
          ? { offerId: row.head_id, status: effectiveStatus(row.head_status, row.head_expires_at ? new Date(row.head_expires_at) : null, now) }
          : null,
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
      canSend: !isThreadClosed({
        requestStatus: row.request_status,
        providerResponse: row.provider_response,
        hasDeclinedOffer: row.declined,
      }),
    };
  });
  return { data, page: buildPage(Number(total), page.limit, page.offset) };
}
