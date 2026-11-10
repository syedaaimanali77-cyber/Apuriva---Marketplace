/** Spec 034 §3.6 request and response types — Ask Apuriva. */
import type { AI_MEMORY_KEYS } from '@/lib/db/schema';

export type AiMessageRole = 'user' | 'assistant';
export type AiActionRiskTier = 'low' | 'medium' | 'high'; // 'restricted' is never executed, so never recorded

export interface AiConversationDto {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiConversationSummaryDto extends AiConversationDto {
  /** The first user message, truncated for display — derived at read time, never stored. */
  preview: string;
}

export interface AiMessageDto {
  id: string;
  role: AiMessageRole;
  body: string;
  createdAt: string;
  /** Present only on the reply that proposes a medium/high action. Not rehydrated when the
   *  transcript is re-read: the confirmation is spec 035's record and may since have gone stale. */
  pendingConfirmation?: AiPendingConfirmationDto;
  /** Present only on the reply that proposes a memory item (§3.9). Never persisted, so never
   *  rehydrated: an unconfirmed proposal leaves no trace. */
  memoryProposal?: AiMemoryProposalDto;
}

export interface AiPendingConfirmationDto {
  /** Opaque, issued by spec 035's confirmation record. */
  confirmationId: string;
  riskTier: 'medium' | 'high';
  /** Plain language, e.g. "Book AC repair with Ali Raza" — never a raw tool identifier (§85). */
  actionLabel: string;
  /** The exact parameters the confirmation is bound to (§90), in display order. */
  parameters: Array<{ label: string; value: string }>;
}

export interface AiActionDto {
  id: string;
  conversationId: string;
  actionLabel: string;
  riskTier: AiActionRiskTier;
  requiredConfirmation: boolean;
  result: 'pending' | 'succeeded' | 'failed';
  related: { type: 'request' | 'booking'; id: string } | null;
  reversible: boolean;
  createdAt: string;
}

/**
 * `POST …/confirm` (spec 034 as amended by spec 036): the recorded action, plus the assistant's
 * reply generated from the action's REAL outcome. `message` is absent on a replay and whenever the
 * reply could not be generated — the action's `result` then stands on its own; nothing is invented.
 */
export interface AiConfirmResultDto extends AiActionDto {
  message?: AiMessageDto;
}

/**
 * One tool call behind an activity entry, in spec 036's minimal redacted structure — IDs, enums,
 * minor units + currency, timestamps, booleans and free-text field NAMES only.
 */
export interface AiToolCallExportEntry {
  inputParams: Record<string, unknown>;
  outputSummary: { type: string; id: string | null; status: string | null } | null;
  errorCode: string | null;
  createdAt: string;
}

/** §3.9 — the closed allow-list. Provider characteristics and communication preferences are
 *  deliberately absent and cannot be stored. */
export type AiMemoryKey = (typeof AI_MEMORY_KEYS)[number];

/** Master spec §5.1's languages as BCP 47 tags: English, Urdu, Roman Urdu. */
export type AiMemoryLanguage = 'en' | 'ur' | 'ur-Latn';

/** Each key's value shape, reusing an existing repository vocabulary (§3.9). */
export interface AiMemoryValueByKey {
  /** A `categories.id` (spec 010) that is `published` when the entry is written. */
  preferred_category: { categoryId: string };
  /** The coarse `city`/`area` fields of spec 012's `StructuredAddress` — never a street address,
   *  address id or coordinates. */
  preferred_area: { city: string; area?: string };
  language: { language: AiMemoryLanguage };
}

export type AiMemoryEntry = {
  [K in AiMemoryKey]: { key: K; value: AiMemoryValueByKey[K] };
}[AiMemoryKey];

export type AiMemoryProposalDto = AiMemoryEntry & {
  /** Human-readable rendering, e.g. "Preferred area: DHA, Lahore" — derived, never stored. */
  valueSummary: string;
};

/** Body of `POST /api/v1/ai/memory` — the user's explicit confirmation of a proposal. */
export type ConfirmAiMemoryRequest = AiMemoryEntry & {
  /** The normal conversation whose reply carried the proposal. */
  conversationId: string;
};

export type AiMemoryItemDto = AiMemoryEntry & {
  id: string;
  /** Human-readable rendering of the stored value — derived at read time. */
  valueSummary: string;
  createdAt: string;
  updatedAt: string;
};

/** Body of `POST /api/v1/ai/temporary-turns` (§3.11). */
export interface AiTemporaryTurnRequest {
  /** The whole temporary transcript so far, held only by the client, ending with the new user
   *  turn. */
  turns: Array<{ role: AiMessageRole; body: string }>;
}

/** Deliberately has no `id`, no `createdAt`, no `pendingConfirmation` and no `memoryProposal`:
 *  a temporary turn is conversation-only — nothing about it is stored, actionable, confirmable or
 *  rememberable. */
export interface AiTemporaryReplyDto {
  role: 'assistant';
  body: string;
}

/** §3.10 — closed. Provider availability/update suggestions are deliberately not produced. */
export type AiProactiveSuggestionKind = 'upcoming_booking' | 'unfinished_request';

export interface AiProactiveSuggestionDto {
  kind: AiProactiveSuggestionKind;
  /** Always present; the UI renders it as the suggestion's attribution (AC-9). */
  source: 'ask_apuriva';
  /** Fixed copy per kind, phrased as a suggestion. It never states or restates a status. */
  text: string;
  /** Where selecting the suggestion navigates. Selecting it does nothing else (AC-15). */
  link: { type: 'booking' | 'request'; id: string };
}

export interface AiPreferencesDto {
  proactiveSuggestionsEnabled: boolean;
}
