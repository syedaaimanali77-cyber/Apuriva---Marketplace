import { afterEach, describe, expect, it } from 'vitest';
import { FEATURE_FLAG_KEYS, FEATURE_FLAG_REGISTRY, envOverride, flagDefinition, isFeatureFlagKey } from './registry';

/** Spec 041 §3.3 (AC-5) — the registry is exactly the approved table. */
const APPROVED = [
  { key: 'onboarding-intro-v1', owningSpec: '007', controlledBy: 'business', isKillSwitch: false, clientReadable: true, default: true, overrideVar: null },
  { key: 'search-nl-interpretation', owningSpec: '013', controlledBy: 'business', isKillSwitch: false, clientReadable: false, default: true, overrideVar: 'SEARCH_NL_INTERPRETATION_ENABLED' },
  { key: 'home-personalization-v1', owningSpec: '014', controlledBy: 'business', isKillSwitch: false, clientReadable: false, default: true, overrideVar: 'HOME_PERSONALIZATION_ENABLED' },
  { key: 'ai-conversational-assistant', owningSpec: '034', controlledBy: 'business', isKillSwitch: false, clientReadable: false, default: true, overrideVar: 'AI_CONVERSATIONAL_ASSISTANT_ENABLED' },
  { key: 'ai-assistant', owningSpec: '033', controlledBy: 'developer', isKillSwitch: true, clientReadable: false, default: true, overrideVar: 'AI_ASSISTANT_ENABLED' },
  { key: 'ai-fraud-signals', owningSpec: '038', controlledBy: 'developer', isKillSwitch: false, clientReadable: false, default: false, overrideVar: 'AI_FRAUD_SIGNALS_ENABLED' },
] as const;

const saved = { ...process.env };
afterEach(() => {
  for (const name of ['AI_ASSISTANT_ENABLED', 'AI_FRAUD_SIGNALS_ENABLED']) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe('the feature-flag registry (spec 041 §3.3, AC-5)', () => {
  it('is exactly the six approved flags, in order, with their documented classification and defaults', () => {
    expect(
      FEATURE_FLAG_REGISTRY.map((f) => ({
        key: f.key,
        owningSpec: f.owningSpec,
        controlledBy: f.controlledBy,
        isKillSwitch: f.isKillSwitch,
        clientReadable: f.clientReadable,
        default: f.defaults.production,
        overrideVar: f.overrideVar,
      })),
    ).toEqual(APPROVED);
  });

  it('every flag has the same documented default in every environment', () => {
    for (const flag of FEATURE_FLAG_REGISTRY) {
      expect(new Set(Object.values(flag.defaults)).size, flag.key).toBe(1);
      expect(Object.keys(flag.defaults).sort()).toEqual(['development', 'production', 'staging']);
    }
  });

  it('only business flags are client-readable, and keys are unique kebab-case', () => {
    for (const flag of FEATURE_FLAG_REGISTRY) {
      if (flag.clientReadable) expect(flag.controlledBy, flag.key).toBe('business');
      expect(flag.key).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      expect(flag.description.length).toBeGreaterThan(0);
      expect(flag.description.length).toBeLessThanOrEqual(500);
    }
    expect(new Set(FEATURE_FLAG_KEYS).size).toBe(FEATURE_FLAG_KEYS.length);
  });

  it('registers none of the flags the owning specs removed or never defined (D-8)', () => {
    for (const key of ['matching-fairness-exposure', 'marketing-notifications', 'urdu-locale', 'demo-mode']) {
      expect(isFeatureFlagKey(key)).toBe(false);
    }
    expect(isFeatureFlagKey(42)).toBe(false);
    expect(isFeatureFlagKey('ai-assistant')).toBe(true);
  });

  it('each override var is read by its readOverride, and only exactly true/false pins a flag', () => {
    for (const flag of FEATURE_FLAG_REGISTRY) {
      if (!flag.overrideVar) {
        expect(flag.readOverride()).toBeUndefined();
        continue;
      }
      const before = process.env[flag.overrideVar];
      process.env[flag.overrideVar] = 'sentinel';
      expect(flag.readOverride(), flag.key).toBe('sentinel');
      if (before === undefined) delete process.env[flag.overrideVar];
      else process.env[flag.overrideVar] = before;
    }
    process.env.AI_ASSISTANT_ENABLED = 'false';
    expect(envOverride('ai-assistant')).toBe(false);
    process.env.AI_FRAUD_SIGNALS_ENABLED = 'true';
    expect(envOverride('ai-fraud-signals')).toBe(true);
    for (const value of ['', 'TRUE', '0', '1', 'yes']) {
      process.env.AI_ASSISTANT_ENABLED = value;
      expect(envOverride('ai-assistant'), JSON.stringify(value)).toBeNull();
    }
    delete process.env.AI_ASSISTANT_ENABLED;
    expect(envOverride('ai-assistant')).toBeNull();
    expect(envOverride('onboarding-intro-v1')).toBeNull();
    expect(flagDefinition('ai-assistant').isKillSwitch).toBe(true);
  });
});
