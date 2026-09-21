/**
 * Spec 034 §3.9 — the CLOSED memory allow-list and each key's value validation.
 *
 * Three keys, each with a fixed value shape taken from a vocabulary the repository already has.
 * There is no free-text key, so no value can carry conversation content or sensitive personal data:
 *
 * | key                | value              | source of the shape                                   |
 * |--------------------|--------------------|-------------------------------------------------------|
 * | preferred_category | `{ categoryId }`   | spec 010 `categories.id`, `published` at write time   |
 * | preferred_area     | `{ city, area? }`  | spec 012 `StructuredAddress.city` / `.area` only      |
 * | language           | `{ language }`     | master spec §5.1: `en`, `ur`, `ur-Latn`               |
 *
 * Preferred provider characteristics and communication preferences are NOT AI memory (AC-19):
 * there is no key for them, so every such attempt is rejected here, by `POST /ai/memory`, and by
 * `ai_memories_key_ck`. Unknown keys are never reinterpreted as a supported one.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { AI_MEMORY_KEYS, categories } from '@/lib/db/schema';
import type { AiMemoryEntry, AiMemoryKey, AiMemoryLanguage } from '@/lib/types/ai-assistant';
import { isUuid } from './errors';
import { AI_MEMORY_KEY_LABELS, AI_MEMORY_LANGUAGE_NAMES } from './labels';

export { AI_MEMORY_KEYS };

export const AI_MEMORY_LANGUAGES: readonly AiMemoryLanguage[] = ['en', 'ur', 'ur-Latn'];

export function isAiMemoryKey(key: unknown): key is AiMemoryKey {
  return typeof key === 'string' && (AI_MEMORY_KEYS as readonly string[]).includes(key);
}

/** The key's plain-language label, e.g. "Preferred area". */
export function memoryKeyLabel(key: AiMemoryKey): string {
  return AI_MEMORY_KEY_LABELS[key];
}

export type MemoryShapeResult =
  | { ok: true; entry: AiMemoryEntry }
  | { ok: false; errors: { field: string; message: string }[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyFields(value: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(value).filter((field) => !allowed.includes(field));
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Pure shape validation (no database). A value must carry EXACTLY its key's fields — any extra
 * field (a street, an address id, coordinates) is rejected rather than silently dropped.
 */
export function validateMemoryShape(key: unknown, value: unknown): MemoryShapeResult {
  if (!isAiMemoryKey(key)) {
    return { ok: false, errors: [{ field: 'key', message: `must be one of ${AI_MEMORY_KEYS.join(', ')}` }] };
  }
  if (!isPlainObject(value)) return { ok: false, errors: [{ field: 'value', message: 'must be an object' }] };

  switch (key) {
    case 'preferred_category': {
      const extra = onlyFields(value, ['categoryId']);
      if (extra.length > 0) return { ok: false, errors: [{ field: 'value', message: `unexpected field(s): ${extra.join(', ')}` }] };
      if (!isUuid(value.categoryId)) return { ok: false, errors: [{ field: 'value.categoryId', message: 'must be a category id' }] };
      return { ok: true, entry: { key, value: { categoryId: value.categoryId } } };
    }
    case 'preferred_area': {
      const extra = onlyFields(value, ['city', 'area']);
      if (extra.length > 0) return { ok: false, errors: [{ field: 'value', message: `unexpected field(s): ${extra.join(', ')}` }] };
      // Spec 012's own rule for these two fields (lib/location/addresses.ts): present and non-blank.
      if (!nonEmptyText(value.city)) return { ok: false, errors: [{ field: 'value.city', message: 'is required' }] };
      if (value.area !== undefined && !nonEmptyText(value.area)) {
        return { ok: false, errors: [{ field: 'value.area', message: 'must be non-empty when present' }] };
      }
      const area = value.area === undefined ? undefined : (value.area as string).trim();
      return {
        ok: true,
        entry: { key, value: area === undefined ? { city: value.city.trim() } : { city: value.city.trim(), area } },
      };
    }
    case 'language': {
      const extra = onlyFields(value, ['language']);
      if (extra.length > 0) return { ok: false, errors: [{ field: 'value', message: `unexpected field(s): ${extra.join(', ')}` }] };
      if (typeof value.language !== 'string' || !(AI_MEMORY_LANGUAGES as readonly string[]).includes(value.language)) {
        return { ok: false, errors: [{ field: 'value.language', message: `must be one of ${AI_MEMORY_LANGUAGES.join(', ')}` }] };
      }
      return { ok: true, entry: { key, value: { language: value.language as AiMemoryLanguage } } };
    }
  }
}

/**
 * Full validation: the shape, plus the one rule that needs the catalogue — a `preferred_category`
 * must name a `published` category when the entry is written (§3.9).
 */
export async function validateMemoryEntry(key: unknown, value: unknown): Promise<MemoryShapeResult> {
  const shape = validateMemoryShape(key, value);
  if (!shape.ok || shape.entry.key !== 'preferred_category') return shape;

  const [category] = await getDb()
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, shape.entry.value.categoryId), eq(categories.status, 'published')));
  if (!category) return { ok: false, errors: [{ field: 'value.categoryId', message: 'must be a published category' }] };
  return shape;
}

/**
 * Human-readable renderings of the VALUES (e.g. "DHA, Lahore", "Plumbing", "Roman Urdu"), derived at
 * read time and never stored. The key's label is rendered separately (§5: "Preferred area — DHA,
 * Lahore"). Category names are resolved in one query.
 */
export async function summarizeMemoryValues(entries: AiMemoryEntry[]): Promise<string[]> {
  const categoryIds = entries.flatMap((e) => (e.key === 'preferred_category' ? [e.value.categoryId] : []));
  const names = new Map<string, string>();
  if (categoryIds.length > 0) {
    const rows = await getDb()
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(inArray(categories.id, categoryIds));
    for (const row of rows) names.set(row.id, row.name);
  }

  return entries.map((entry) => {
    switch (entry.key) {
      case 'preferred_category':
        return names.get(entry.value.categoryId) ?? 'A category that is no longer available';
      case 'preferred_area':
        // The coarse-location join spec 012 already uses (lib/location/privacy.ts): "area, city".
        return [entry.value.area, entry.value.city].filter((part): part is string => Boolean(part)).join(', ');
      case 'language':
        return AI_MEMORY_LANGUAGE_NAMES[entry.value.language];
    }
  });
}
