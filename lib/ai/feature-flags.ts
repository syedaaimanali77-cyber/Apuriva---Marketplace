/**
 * Spec 033 §9: the `ai-assistant` flag has no runtime infrastructure to live in yet —
 * `feature_flags` is still a bare baseline table (spec 041, not implemented), the same gap spec
 * 013's `search-nl-interpretation` and spec 014's `home-personalization-v1` already ship around.
 * This ships as an environment variable until spec 041's real read/write mechanism exists, then
 * migrates to it without a contract change (callers only ever see this one function).
 *
 * It is the platform-wide kill switch (master spec §119): off makes every `completeAi()` call
 * throw `AiUnavailableError`, which every consumer already degrades on. Each consuming feature
 * keeps its own narrower flag, so spec 013's search interpretation can still be disabled alone.
 */
export function isAiAssistantEnabled(): boolean {
  return process.env.AI_ASSISTANT_ENABLED !== 'false';
}
