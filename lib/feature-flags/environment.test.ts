import { afterEach, describe, expect, it } from 'vitest';
import { currentFlagEnvironment, FeatureFlagEnvironmentError, isFlagEnvironment } from './environment';

const saved = { APP_ENV: process.env.APP_ENV, NODE_ENV: process.env.NODE_ENV };
const env = process.env as Record<string, string | undefined>;

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
});

/** Spec 041 §3.2 (AC-6) — which environment this deployment is. */
describe('currentFlagEnvironment (spec 041 §3.2)', () => {
  it('APP_ENV names the environment', () => {
    for (const value of ['development', 'staging', 'production'] as const) {
      env.APP_ENV = value;
      expect(currentFlagEnvironment()).toBe(value);
    }
  });

  it('unset or empty falls back to NODE_ENV: production → production, anything else → development', () => {
    delete env.APP_ENV;
    env.NODE_ENV = 'production';
    expect(currentFlagEnvironment()).toBe('production');
    env.NODE_ENV = 'test';
    expect(currentFlagEnvironment()).toBe('development');
    env.APP_ENV = '';
    env.NODE_ENV = 'development';
    expect(currentFlagEnvironment()).toBe('development');
  });

  it('any other value is a configuration error, never silently mapped (staging must be explicit)', () => {
    for (const value of ['prod', 'Staging', 'test', 'preview']) {
      env.APP_ENV = value;
      expect(() => currentFlagEnvironment()).toThrow(FeatureFlagEnvironmentError);
    }
    env.APP_ENV = 'prod';
    expect(() => currentFlagEnvironment()).toThrow(/APP_ENV must be one of development, staging, production; got "prod"/);
  });

  it('isFlagEnvironment is a closed guard', () => {
    expect(isFlagEnvironment('staging')).toBe(true);
    expect(isFlagEnvironment('qa')).toBe(false);
    expect(isFlagEnvironment(undefined)).toBe(false);
  });
});
