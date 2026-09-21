/**
 * Spec 034 §3.10 — proactive suggestions. EXACTLY two kinds; provider availability/update
 * suggestions are deliberately not produced (by decision).
 *
 * | kind               | condition (existing data)                                                   | links to        |
 * |--------------------|-----------------------------------------------------------------------------|-----------------|
 * | upcoming_booking   | the caller's earliest `confirmed` booking whose `scheduled_at` is in future | app/bookings/id |
 * | unfinished_request | the caller's most recently updated request in `offers_open`                 | app/requests/id |
 *
 * LOW FREQUENCY BY CONSTRUCTION: derived at read time only when the user opens the panel (pull,
 * never push, never a spec 026 notification), at most one per kind, and self-expiring the moment
 * its condition stops holding. NO AI CALL: fixed copy spends no quota and cannot rewrite a system
 * status (master spec §84). NEVER AN ACTION: a read-only query — no write, no executor (AC-15).
 *
 * Every suggestion is non-essential, so the preference turns off every one. Anything essential is a
 * system fact delivered by its owning spec through spec 026, which the preference never affects.
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { customerProfiles, users } from '@/lib/db/schema';
import { queryRows } from '@/lib/offers/db';
import type { AiPreferencesDto, AiProactiveSuggestionDto } from '@/lib/types/ai-assistant';
import { validationError } from '@/lib/api/errors';
import { isAskApurivaAvailable } from './feature-flags';

/** Fixed copy per kind, phrased as a suggestion; it never states or restates a status. */
export const SUGGESTION_TEXT: Record<AiProactiveSuggestionDto['kind'], string> = {
  upcoming_booking: 'Ask Apuriva suggests reviewing your upcoming booking.',
  unfinished_request: 'Ask Apuriva suggests taking a look at your request.',
};

/** `GET /api/v1/ai/suggestions` — `[]` when off, when the assistant is off, or without a customer profile. */
export async function listSuggestions(userId: string): Promise<AiProactiveSuggestionDto[]> {
  if (!isAskApurivaAvailable()) return [];
  const preferences = await getAiPreferences(userId);
  if (!preferences.proactiveSuggestionsEnabled) return [];

  const db = getDb();
  const [customer] = await db
    .select({ id: customerProfiles.id })
    .from(customerProfiles)
    .where(eq(customerProfiles.userId, userId));
  if (!customer) return [];

  const suggestions: AiProactiveSuggestionDto[] = [];

  const [booking] = await queryRows<{ id: string }>(
    db,
    sql`SELECT id FROM bookings
         WHERE customer_profile_id = ${customer.id} AND status = 'confirmed' AND scheduled_at > clock_timestamp()
         ORDER BY scheduled_at ASC, id ASC LIMIT 1`,
  );
  if (booking) {
    suggestions.push({
      kind: 'upcoming_booking',
      source: 'ask_apuriva',
      text: SUGGESTION_TEXT.upcoming_booking,
      link: { type: 'booking', id: booking.id },
    });
  }

  const [request] = await queryRows<{ id: string }>(
    db,
    sql`SELECT id FROM requests
         WHERE customer_profile_id = ${customer.id} AND status = 'offers_open'
         ORDER BY updated_at DESC, id DESC LIMIT 1`,
  );
  if (request) {
    suggestions.push({
      kind: 'unfinished_request',
      source: 'ask_apuriva',
      text: SUGGESTION_TEXT.unfinished_request,
      link: { type: 'request', id: request.id },
    });
  }

  return suggestions;
}

/** `GET /api/v1/users/me/ai-preferences`. */
export async function getAiPreferences(userId: string): Promise<AiPreferencesDto> {
  const [row] = await getDb()
    .select({ enabled: users.aiProactiveSuggestionsEnabled })
    .from(users)
    .where(eq(users.id, userId));
  return { proactiveSuggestionsEnabled: row?.enabled ?? true };
}

/** `PATCH /api/v1/users/me/ai-preferences` — never gated by the assistant flag (a privacy control). */
export async function updateAiPreferences(userId: string, rawBody: unknown): Promise<AiPreferencesDto> {
  const body = (typeof rawBody === 'object' && rawBody !== null && !Array.isArray(rawBody) ? rawBody : {}) as Record<string, unknown>;
  const extra = Object.keys(body).filter((field) => field !== 'proactiveSuggestionsEnabled');
  if (extra.length > 0) throw validationError([{ field: 'body', message: `unexpected field(s): ${extra.join(', ')}` }]);
  if (typeof body.proactiveSuggestionsEnabled !== 'boolean') {
    throw validationError([{ field: 'proactiveSuggestionsEnabled', message: 'must be a boolean' }]);
  }
  await getDb()
    .update(users)
    .set({ aiProactiveSuggestionsEnabled: body.proactiveSuggestionsEnabled, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return { proactiveSuggestionsEnabled: body.proactiveSuggestionsEnabled };
}
