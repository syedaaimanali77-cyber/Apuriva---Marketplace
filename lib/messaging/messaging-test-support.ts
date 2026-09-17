/**
 * Spec 025 §6 fixtures.
 *
 * Built on spec 021's payment fixtures, which run the REAL spec 015→020 path: a genuine request, offer,
 * acceptance and booking. Nothing fakes a booking status: `pending` is a freshly created booking, `confirmed`
 * is one whose payment spec 021 genuinely authorized, and an archived booking is a `pending` one failed
 * through spec 020's `applyBookingTransition` on the transition spec 021 registers. Every request goes
 * through the real route handlers with real sessions against the isolated `*_test` database.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { applyBookingTransition } from '@/lib/bookings';
import { createBooking } from '@/lib/bookings/create';
import { queryRows } from '@/lib/offers/db';
import { authorizePayment } from '@/lib/payments/authorize';
import {
  createBookingBody,
  freshKey,
  resetPaymentIntegration,
  seedBookingScenario,
  sessionGet,
  sessionMutate,
  usePaymentIntegration,
  type BookingScenario,
} from '@/lib/payments/payments-test-support';
import { GET as GET_CONVERSATION } from '@/app/api/v1/bookings/[id]/conversation/route';
import { GET as LIST_MESSAGES, POST as SEND_MESSAGE } from '@/app/api/v1/bookings/[id]/conversation/messages/route';
import { POST as MARK_READ } from '@/app/api/v1/bookings/[id]/conversation/read/route';
import type { TestSession } from '@/lib/offers/offers-test-support';
import type { MessageDto } from '@/lib/types/messaging';
import { resetConversationBlockGate } from './block-gate';
import { resetMessagingNotificationSink } from './notifications';

export { freshKey, isDatabaseReachable, seedStranger, sessionGet, type BookingScenario } from '@/lib/payments/payments-test-support';
export { registerAdmin, grantRole } from '@/app/api/v1/admin/admin-rbac-test-support';

export const BASE = 'http://localhost/api/v1';

/** Registers spec 021's seams and restores this spec's inert ports, per test file. */
export function useMessagingIntegration(): void {
  usePaymentIntegration();
  resetConversationBlockGate();
  resetMessagingNotificationSink();
  resetRateLimitState();
}

export function resetMessagingIntegration(): void {
  resetPaymentIntegration();
  resetConversationBlockGate();
  resetMessagingNotificationSink();
}

/** A freshly created booking, still `pending` (payment not authorized — pre-confirmation). */
export async function seedPendingBooking(): Promise<{ scenario: BookingScenario; bookingId: string }> {
  const scenario = await seedBookingScenario();
  const { booking } = await createBooking(scenario.customer.userId, randomUUID(), createBookingBody(scenario.offerId));
  resetRateLimitState();
  return { scenario, bookingId: booking.id };
}

/** A booking whose payment spec 021 authorized, so it has reached `confirmed`. */
export async function seedConfirmedBooking(): Promise<{ scenario: BookingScenario; bookingId: string }> {
  const seeded = await seedPendingBooking();
  await authorizePayment(seeded.scenario.customer.userId, seeded.bookingId, freshKey());
  resetRateLimitState();
  return seeded;
}

/** `pending -> failed` through spec 020's primitive — an archived status, reached the real way. */
export async function archivePendingBooking(bookingId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [row] = await queryRows<{ version: number }>(tx, sql`SELECT version FROM bookings WHERE id = ${bookingId}`);
    const result = await applyBookingTransition(tx, {
      bookingId,
      from: 'pending',
      to: 'failed',
      actorRole: 'system',
      actorUserId: null,
      expectedVersion: row!.version,
    });
    if (!result.applied) throw new Error(`could not archive booking ${bookingId}: ${result.currentStatus}`);
  });
}

export async function bookingStatusOf(bookingId: string): Promise<string> {
  const [row] = await queryRows<{ status: string }>(getDb(), sql`SELECT status FROM bookings WHERE id = ${bookingId}`);
  return row!.status;
}

export function conversationUrl(bookingId: string, suffix = ''): string {
  return `${BASE}/bookings/${bookingId}/conversation${suffix}`;
}

export async function json(response: Response): Promise<Record<string, any>> {
  return (await response.json()) as Record<string, any>;
}

export function getConversation(session: TestSession, bookingId: string): Promise<Response> {
  return GET_CONVERSATION(sessionGet(conversationUrl(bookingId), session));
}

export function listMessages(session: TestSession, bookingId: string, query = ''): Promise<Response> {
  return LIST_MESSAGES(sessionGet(conversationUrl(bookingId, `/messages${query}`), session));
}

export function sendMessage(session: TestSession, bookingId: string, body: unknown, key: string | null = freshKey()): Promise<Response> {
  const base = sessionMutate(conversationUrl(bookingId, '/messages'), session, 'POST', body);
  const headers = new Headers(base.headers);
  if (key !== null) headers.set('Idempotency-Key', key);
  return SEND_MESSAGE(new Request(base, { headers }));
}

export function markRead(session: TestSession, bookingId: string, lastReadMessageId: unknown): Promise<Response> {
  return MARK_READ(sessionMutate(conversationUrl(bookingId, '/read'), session, 'POST', { lastReadMessageId }));
}

/** Sends and returns the stored message DTO, failing loudly on anything but `201`. */
export async function sent(session: TestSession, bookingId: string, text: string): Promise<MessageDto> {
  const response = await sendMessage(session, bookingId, { body: text });
  const payload = await json(response);
  if (response.status !== 201) throw new Error(`send failed ${response.status}: ${JSON.stringify(payload)}`);
  resetRateLimitState();
  return payload.data as MessageDto;
}

export async function storedMessages(bookingId: string) {
  return queryRows<{
    id: string;
    body: string;
    sender_role: string;
    contact_redacted: boolean;
    contact_flagged: boolean;
    redacted_by_retention: boolean;
    created_at: Date;
  }>(
    getDb(),
    sql`SELECT m.id, m.body, m.sender_role, m.contact_redacted, m.contact_flagged, m.redacted_by_retention, m.created_at
          FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.booking_id = ${bookingId}
         ORDER BY m.created_at ASC, m.id ASC`,
  );
}

export async function conversationRowFor(bookingId: string) {
  const [row] = await queryRows<{ id: string; archived_at: Date | null; retention_applied_at: Date | null }>(
    getDb(),
    sql`SELECT id, archived_at, retention_applied_at FROM conversations WHERE booking_id = ${bookingId}`,
  );
  return row;
}

/** Backdates `archived_at` so the retention window has elapsed, without sleeping. */
export async function ageArchive(conversationId: string, daysAgo: number): Promise<void> {
  await getDb().execute(sql`
    UPDATE conversations SET archived_at = clock_timestamp() - make_interval(days => ${daysAgo}) WHERE id = ${conversationId}
  `);
}
