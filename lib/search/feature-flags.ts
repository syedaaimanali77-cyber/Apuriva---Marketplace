/**
 * Spec 013 §9/§8 risk #3: the `search-nl-interpretation` flag has no runtime infrastructure to
 * live in yet — `feature_flags` is still a bare baseline table (spec 041, not implemented). This
 * ships as an environment variable until spec 041's real read/write mechanism exists, then
 * migrates to it without a contract change (callers only ever see this one function).
 */
export function isNlInterpretationEnabled(): boolean {
  return process.env.SEARCH_NL_INTERPRETATION_ENABLED !== 'false';
}
