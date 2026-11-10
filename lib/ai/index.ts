/**
 * Spec 033 — the public face of `lib/ai`. Consumers import from here; `lib/ai/provider/**` is the
 * vendor boundary and is deliberately NOT re-exported, so no module outside this directory can
 * reach an adapter (AC-1, enforced by `lib/ai/boundary.test.ts`).
 */
export { completeAi } from './complete';
export {
  AiProviderConfigurationError,
  AiQuotaExceededError,
  AiRateLimitedError,
  AiUnavailableError,
  isAiDegradable,
} from './errors';
export { isAiAssistantEnabled } from './feature-flags';
export { AI_READ_USAGE_ACTION, AI_RESOURCE, requireAiUsagePermission } from './permissions';
export { getAiUsageSummary, sweepAiUsageRetention } from './usage';
export { evaluateAiAbuseSignals, AI_ABUSE_EVENT_TYPE } from './abuse';
export { evaluateAiCostAlerts, estimateAiCostMinorUnits, AI_COST_ALERT_EVENT_TYPE } from './cost';
export type { AiCompletionRequest, AiCompletionResult, AiSubject, AiTask } from './types';
export type { AiIntentInterpreter, RawSearchIntent } from './intent-interpreter';
export { getIntentInterpreter } from './intent-interpreter';
