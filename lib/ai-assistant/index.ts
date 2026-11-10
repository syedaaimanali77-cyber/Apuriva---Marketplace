/**
 * Spec 034 — Ask Apuriva: conversations, temporary turns, memory, proactive suggestions, activity,
 * risk policy and the (inert) executor port. Transcript persistence lives HERE, never in `lib/ai`,
 * which spec 033 keeps content-free; AI is reached only through the `@/lib/ai` barrel.
 */
export { isConversationalAssistantEnabled, isAskApurivaAvailable, requireAskApurivaAvailable } from './feature-flags';
export {
  createConversation,
  listConversations,
  listTranscript,
  deleteConversation,
  clearHistory,
} from './conversations';
export { sendTurn, sendTemporaryTurn } from './turns';
export { listMemory, confirmMemory, deleteMemoryEntry, resetMemory } from './memory';
export { memoryKeyLabel, isAiMemoryKey, AI_MEMORY_KEYS } from './memory-keys';
export { listSuggestions, getAiPreferences, updateAiPreferences } from './suggestions';
export { confirmAction, listActivity } from './actions';
export { decideRisk, requiresConfirmation, type AiProposedRiskTier } from './risk-policy';
export {
  registerAiActionExecutor,
  getAiActionExecutor,
  resetAiActionExecutor,
  type AiActionExecutor,
  type AiActionContext,
  type AiProposedAction,
} from './executor';
export { exportAiAssistantData, removeAiAssistantDataForDeletedUser, type ExportedAiAssistantData } from './privacy';
