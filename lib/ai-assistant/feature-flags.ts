/**
 * Spec 034 §9: the `ai-conversational-assistant` flag. Like spec 033's `ai-assistant` and spec 013's
 * `search-nl-interpretation`, it ships as an environment variable until spec 041's registry exists.
 *
 * It is INDEPENDENT of spec 033's platform-wide kill switch. With EITHER off, the routes that start
 * something — a conversation, a turn, a temporary turn, an action confirmation, a memory
 * confirmation — return `503 AI_PROVIDER_UNAVAILABLE`. Privacy rights are never gated by it:
 * reading, searching, deleting and clearing conversations, memory view/delete/reset, the
 * preference, activity history, export and the deletion sweep all keep working (master §81, §82).
 */
import { AiUnavailableError, isAiAssistantEnabled } from '@/lib/ai';

export function isConversationalAssistantEnabled(): boolean {
  return process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED !== 'false';
}

/** True only when both this spec's flag and spec 033's platform kill switch are on. */
export function isAskApurivaAvailable(): boolean {
  return isConversationalAssistantEnabled() && isAiAssistantEnabled();
}

/** Throws spec 033's `AiUnavailableError` (`503 AI_PROVIDER_UNAVAILABLE`) unless both flags are on. */
export function requireAskApurivaAvailable(): void {
  if (!isAskApurivaAvailable()) throw new AiUnavailableError('Ask Apuriva is temporarily unavailable.');
}
