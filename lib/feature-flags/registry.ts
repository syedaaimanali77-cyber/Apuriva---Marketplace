/**
 * Spec 041 §3.3 (AC-5) — THE flag registry: a closed, typed list and the source of truth for keys,
 * classification and defaults. Migration 0036 seeds exactly these rows; `registry.test.ts` and
 * `migration.integration.test.ts` assert the two agree.
 *
 * Every default is the one its owning spec documents. `readOverride` reads the spec's pre-041
 * environment-variable stand-in, kept as a deploy-level override (D-3); a flag without one has none.
 * Each override is read through a literal environment access, so `npm run check:env` sees every variable.
 *
 * Adding a flag later = one entry here + a new migration that seeds its three environment rows.
 */
import type { FlagControl, FlagEnvironment } from '@/lib/types/feature-flags';

export interface FeatureFlagDefinition {
  key: string;
  owningSpec: string;
  description: string;
  controlledBy: FlagControl;
  isKillSwitch: boolean;
  /** Returned by `GET /api/v1/feature-flags/effective`. Business flags only (AC-2). */
  clientReadable: boolean;
  defaults: Readonly<Record<FlagEnvironment, boolean>>;
  /** The env var that pins the flag when set to exactly 'true'/'false', or null. */
  overrideVar: string | null;
  readOverride: () => string | undefined;
}

const everywhere = (value: boolean) => ({ development: value, staging: value, production: value }) as const;

export const FEATURE_FLAG_REGISTRY = [
  {
    key: 'onboarding-intro-v1',
    owningSpec: '007',
    description: 'Shows the first-run introduction to new visitors; off hides it without a redeploy (spec 007).',
    controlledBy: 'business',
    isKillSwitch: false,
    clientReadable: true,
    defaults: everywhere(true),
    overrideVar: null,
    readOverride: () => undefined,
  },
  {
    key: 'search-nl-interpretation',
    owningSpec: '013',
    description: 'AI interpretation of natural-language search; off falls back to keyword-only search (spec 013).',
    controlledBy: 'business',
    isKillSwitch: false,
    clientReadable: false,
    defaults: everywhere(true),
    overrideVar: 'SEARCH_NL_INTERPRETATION_ENABLED',
    readOverride: () => process.env.SEARCH_NL_INTERPRETATION_ENABLED,
  },
  {
    key: 'home-personalization-v1',
    owningSpec: '014',
    description: 'Personalized home feed; off falls back to the static curated feed for everyone (spec 014).',
    controlledBy: 'business',
    isKillSwitch: false,
    clientReadable: false,
    defaults: everywhere(true),
    overrideVar: 'HOME_PERSONALIZATION_ENABLED',
    readOverride: () => process.env.HOME_PERSONALIZATION_ENABLED,
  },
  {
    key: 'ai-conversational-assistant',
    owningSpec: '034',
    description: 'Ask Apuriva conversations and actions; off refuses new conversations, turns and confirmations (spec 034).',
    controlledBy: 'business',
    isKillSwitch: false,
    clientReadable: false,
    defaults: everywhere(true),
    overrideVar: 'AI_CONVERSATIONAL_ASSISTANT_ENABLED',
    readOverride: () => process.env.AI_CONVERSATIONAL_ASSISTANT_ENABLED,
  },
  {
    key: 'ai-assistant',
    owningSpec: '033',
    description: 'Platform-wide AI kill switch; off makes every AI call unavailable and every AI feature degrade (spec 033).',
    controlledBy: 'developer',
    isKillSwitch: true,
    clientReadable: false,
    defaults: everywhere(true),
    overrideVar: 'AI_ASSISTANT_ENABLED',
    readOverride: () => process.env.AI_ASSISTANT_ENABLED,
  },
  {
    key: 'ai-fraud-signals',
    owningSpec: '038',
    description: 'Allows AI-assisted fraud signals to be recorded as review items; never enforces anything (spec 038).',
    controlledBy: 'developer',
    isKillSwitch: false,
    clientReadable: false,
    defaults: everywhere(false),
    overrideVar: 'AI_FRAUD_SIGNALS_ENABLED',
    readOverride: () => process.env.AI_FRAUD_SIGNALS_ENABLED,
  },
] as const satisfies readonly FeatureFlagDefinition[];

export type FeatureFlagKey = (typeof FEATURE_FLAG_REGISTRY)[number]['key'];
export type ClientFlagKey = Extract<(typeof FEATURE_FLAG_REGISTRY)[number], { clientReadable: true }>['key'];

export const FEATURE_FLAG_KEYS: readonly FeatureFlagKey[] = FEATURE_FLAG_REGISTRY.map((f) => f.key);

export function isFeatureFlagKey(value: unknown): value is FeatureFlagKey {
  return typeof value === 'string' && (FEATURE_FLAG_KEYS as readonly string[]).includes(value);
}

export function flagDefinition(key: FeatureFlagKey): FeatureFlagDefinition {
  return FEATURE_FLAG_REGISTRY.find((f) => f.key === key)!;
}

/** The env override for a flag: exactly 'true'/'false' pins it; anything else is no override. */
export function envOverride(key: FeatureFlagKey): boolean | null {
  const raw = flagDefinition(key).readOverride();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}
