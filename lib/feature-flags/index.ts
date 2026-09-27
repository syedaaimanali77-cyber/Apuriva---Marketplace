/** Spec 041 — the feature-flag system's public surface. */
export { isFeatureEnabled, resolveClientFlags } from './resolve';
export { currentFlagEnvironment, FeatureFlagEnvironmentError } from './environment';
export { FEATURE_FLAG_REGISTRY, FEATURE_FLAG_KEYS, isFeatureFlagKey, type ClientFlagKey, type FeatureFlagKey } from './registry';
export { listFeatureFlags, toggleFeatureFlag } from './admin';
