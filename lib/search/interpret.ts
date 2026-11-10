import { and, eq, ilike } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { services } from '@/lib/db/schema';
import { getIntentInterpreter } from '@/lib/ai/intent-interpreter';
import type { SearchIntentDto } from '@/lib/types/search';
import { interpretationLowConfidenceError, validationError } from './errors';

/**
 * §3 `POST /api/v1/search/interpret` — AI-assisted, read-only (spec 034's autonomy-tier model
 * names "search" as low-risk). `lib/ai`'s interpreter only extracts raw text signals; resolving
 * `serviceNameRaw` against a real, published `services.name` row (the only thing that can turn a
 * guess into an authoritative `serviceId`) happens here, against the database — the AI never
 * touches `services` directly and never returns a result itself (AC-1). This function returns a
 * *suggestion* only; it is never wired to render results on its own (§3).
 */
export async function interpretSearchQuery(text: string): Promise<SearchIntentDto> {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw validationError([{ field: 'text', message: 'is required' }]);
  }

  const raw = await getIntentInterpreter().interpret(text);

  let serviceId: string | undefined;
  if (raw.serviceNameRaw) {
    const [match] = await getDb()
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.status, 'published'), ilike(services.name, `%${raw.serviceNameRaw}%`)))
      .limit(1);
    serviceId = match?.id;
  }

  const fieldsExtracted = [serviceId ?? raw.serviceNameRaw, raw.area, raw.date, raw.budgetMaxMinorUnits].filter(
    (v) => v !== undefined,
  ).length;

  const confidence: SearchIntentDto['confidence'] = fieldsExtracted >= 3 ? 'high' : fieldsExtracted === 2 ? 'medium' : 'low';

  if (fieldsExtracted === 0) throw interpretationLowConfidenceError();

  return {
    serviceId,
    serviceNameRaw: serviceId ? undefined : raw.serviceNameRaw,
    area: raw.area,
    date: raw.date,
    budgetMaxMinorUnits: raw.budgetMaxMinorUnits,
    currencyCode: raw.currencyCode,
    confidence,
  };
}
