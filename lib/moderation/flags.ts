/**
 * Spec 038 §3.6 / §9 — the `ai-fraud-signals` flag.
 *
 * `feature_flags` is still a bare baseline table (spec 041, Draft), so this ships as an environment
 * variable — the idiom `lib/ai/feature-flags.ts` established for spec 033 — and migrates to spec
 * 041's mechanism without a contract change. DEFAULT OFF: only the literal `true` enables it.
 *
 * It gates only the `ai_assisted` signal SOURCE. No AI producer ships in spec 038, and even when on,
 * an AI signal is still just a review item (AC-3).
 */
export function isAiFraudSignalsEnabled(): boolean {
  return process.env.AI_FRAUD_SIGNALS_ENABLED === 'true';
}
