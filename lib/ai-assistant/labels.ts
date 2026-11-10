/**
 * Spec 034 §3.9 / §5 — plain-language labels shared by the server (value summaries) and the client
 * (the memory page and the memory-proposal card). Pure: no database, safe in a client component.
 */
import type { AiMemoryKey, AiMemoryLanguage } from '@/lib/types/ai-assistant';

export const AI_MEMORY_KEY_LABELS: Record<AiMemoryKey, string> = {
  preferred_category: 'Preferred category',
  preferred_area: 'Preferred area',
  language: 'Language',
};

/** Master spec §5.1's names for the three languages. */
export const AI_MEMORY_LANGUAGE_NAMES: Record<AiMemoryLanguage, string> = {
  en: 'English',
  ur: 'Urdu',
  'ur-Latn': 'Roman Urdu',
};
