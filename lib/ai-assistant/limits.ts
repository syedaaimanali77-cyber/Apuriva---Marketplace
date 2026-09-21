/**
 * Spec 034 §3.7 bounds. The turn body and the search `q` reuse spec 025's
 * `MESSAGE_BODY_MAX_LENGTH`, the bound spec 032 already applies to its own assistant question
 * (`MAX_ASSISTANT_QUESTION_LENGTH`). Validation only — there is no database CHECK on `ai_messages.body`,
 * because an assistant reply is bounded by spec 033's token cap, not by this length.
 */
import { MESSAGE_BODY_MAX_LENGTH } from '@/lib/messaging/limits';

export const AI_TURN_BODY_MAX_LENGTH = MESSAGE_BODY_MAX_LENGTH;
export const AI_SEARCH_QUERY_MAX_LENGTH = MESSAGE_BODY_MAX_LENGTH;

/** `AiConversationSummaryDto.preview`: the first user message, truncated to this many characters. */
export const AI_CONVERSATION_PREVIEW_LENGTH = 120;
