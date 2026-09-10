/**
 * Spec 014 §9/§8 risk #5: the `home-personalization-v1` flag has no runtime infrastructure to
 * live in yet — `feature_flags` is still a bare baseline table (spec 041, not implemented), the
 * same gap spec 013 §8 risk #3 already hit for `search-nl-interpretation`. This ships as an
 * environment variable until spec 041's real read/write mechanism exists, then migrates to it
 * without a contract change (callers only ever see this one function).
 */
export function isHomePersonalizationEnabled(): boolean {
  return process.env.HOME_PERSONALIZATION_ENABLED !== 'false';
}
