import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ApiRouteError } from '@/lib/api/errors';
import {
  PLATFORM_DEFAULT_CANCELLATION_CONFIG,
  parseCancellationPolicyConfig,
  validateCancellationPolicyConfig,
} from './policy-config';

function expectInvalid(value: unknown): ApiRouteError {
  try {
    validateCancellationPolicyConfig(value);
  } catch (err) {
    expect((err as ApiRouteError).code).toBe('POLICY_CONFIG_INVALID');
    expect((err as ApiRouteError).status).toBe(422);
    return err as ApiRouteError;
  }
  throw new Error('expected POLICY_CONFIG_INVALID to be thrown');
}

const VALID = PLATFORM_DEFAULT_CANCELLATION_CONFIG;

describe('the platform default ladder (spec 023 AC-2/AC-3)', () => {
  /**
   * The exact Product decision the approved spec records: 0 / 25 / 50 / 100. Asserted literally so
   * the numbers cannot drift without a test failing and a human re-reading the spec.
   */
  it('is exactly 0% beyond 24h, 25% in [12h,24h), 50% under 12h and 100% at or after the time', () => {
    expect(VALID.tiers).toEqual([
      { minHoursBefore: 24, maxHoursBefore: null, feePercent: 0 },
      { minHoursBefore: 12, maxHoursBefore: 24, feePercent: 25 },
      { minHoursBefore: 0, maxHoursBefore: 12, feePercent: 50 },
      { minHoursBefore: null, maxHoursBefore: 0, feePercent: 100 },
    ]);
    expect(VALID.allowedOptions).toEqual([]);
  });

  it('validates against its own grammar', () => {
    expect(validateCancellationPolicyConfig(VALID)).toEqual(VALID);
  });

  /**
   * The constant and migration `0019`'s seed are two statements of one decision. If they ever
   * disagree, the policy a booking resolves would differ from the policy this code believes in —
   * so the migration's literal JSON is parsed and compared here rather than trusted.
   */
  it('matches the ladder migration 0019 actually seeds', () => {
    const sqlText = readFileSync(join(process.cwd(), 'drizzle', '0019_add_cancellation_policy_no_show.sql'), 'utf8');
    const match = sqlText.match(/'(\{"tiers":[\s\S]*?\})'::jsonb/);
    expect(match, 'the seeded config JSON should be findable in 0019').not.toBeNull();
    expect(JSON.parse(match![1]!)).toEqual(VALID);
  });
});

describe('policy configuration validation (spec 023 §3 "Policy model")', () => {
  it('rejects a non-object', () => {
    expectInvalid(null);
    expectInvalid([]);
    expectInvalid('tiers');
  });

  it('rejects an empty or missing ladder', () => {
    expectInvalid({ tiers: [] });
    expectInvalid({ allowedOptions: [] });
  });

  it('rejects a fee percentage outside 0–100, or a non-integer one', () => {
    const error = expectInvalid({
      tiers: [
        { minHoursBefore: 24, maxHoursBefore: null, feePercent: 101 },
        { minHoursBefore: null, maxHoursBefore: 24, feePercent: 50 },
      ],
      allowedOptions: [],
    });
    expect(error.errors?.some((e) => e.field.endsWith('feePercent'))).toBe(true);
    expectInvalid({ tiers: [{ minHoursBefore: null, maxHoursBefore: null, feePercent: 12.5 }], allowedOptions: [] });
    expectInvalid({ tiers: [{ minHoursBefore: null, maxHoursBefore: null, feePercent: -1 }], allowedOptions: [] });
  });

  it('rejects a ladder with a gap, so no timing can fall between two tiers', () => {
    const error = expectInvalid({
      tiers: [
        { minHoursBefore: 24, maxHoursBefore: null, feePercent: 0 },
        { minHoursBefore: null, maxHoursBefore: 12, feePercent: 50 },
      ],
      allowedOptions: [],
    });
    expect(error.errors?.some((e) => e.message.includes('no gap'))).toBe(true);
  });

  it('rejects a ladder that is not exhaustive at either end', () => {
    expectInvalid({
      tiers: [{ minHoursBefore: 24, maxHoursBefore: 48, feePercent: 0 }],
      allowedOptions: [],
    });
  });

  /** A ladder that got cheaper closer to the appointment would reward cancelling late. */
  it('rejects a ladder whose fee decreases as the booking approaches', () => {
    const error = expectInvalid({
      tiers: [
        { minHoursBefore: 24, maxHoursBefore: null, feePercent: 50 },
        { minHoursBefore: null, maxHoursBefore: 24, feePercent: 10 },
      ],
      allowedOptions: [],
    });
    expect(error.errors?.some((e) => e.message.includes('never cost less'))).toBe(true);
  });

  it('accepts a valid two-tier ladder', () => {
    const config = {
      tiers: [
        { minHoursBefore: 48, maxHoursBefore: null, feePercent: 0 },
        { minHoursBefore: null, maxHoursBefore: 48, feePercent: 30 },
      ],
      allowedOptions: [],
    };
    expect(validateCancellationPolicyConfig(config)).toEqual(config);
  });

  it('defaults allowedOptions to an empty list when absent', () => {
    const parsed = validateCancellationPolicyConfig({ tiers: VALID.tiers });
    expect(parsed.allowedOptions).toEqual([]);
  });
});

describe('provider-selectable options (spec 023 AC-4)', () => {
  it('accepts well-formed options', () => {
    const config = {
      tiers: VALID.tiers,
      allowedOptions: [
        { key: 'flexible', tiers: [{ minHoursBefore: null, maxHoursBefore: null, feePercent: 0 }] },
        { key: 'strict_48', tiers: [{ minHoursBefore: null, maxHoursBefore: null, feePercent: 100 }] },
      ],
    };
    expect(validateCancellationPolicyConfig(config).allowedOptions).toHaveLength(2);
  });

  it('rejects a duplicate or malformed option key', () => {
    const flat = [{ minHoursBefore: null, maxHoursBefore: null, feePercent: 0 }];
    expectInvalid({ tiers: VALID.tiers, allowedOptions: [{ key: 'a', tiers: flat }, { key: 'a', tiers: flat }] });
    expectInvalid({ tiers: VALID.tiers, allowedOptions: [{ key: 'Not A Key', tiers: flat }] });
    expectInvalid({ tiers: VALID.tiers, allowedOptions: [{ key: '', tiers: flat }] });
  });

  /** An option is a ladder like any other: it cannot be laxer than the grammar the policy obeys. */
  it("holds an option's own ladder to the same rules", () => {
    expectInvalid({
      tiers: VALID.tiers,
      allowedOptions: [{ key: 'broken', tiers: [{ minHoursBefore: 24, maxHoursBefore: 48, feePercent: 0 }] }],
    });
  });

  it('never accepts a bare percentage in place of a ladder', () => {
    expectInvalid({ tiers: VALID.tiers, allowedOptions: [{ key: 'flat', tiers: 25 }] });
  });
});

describe('reading a stored configuration back', () => {
  it('treats an invalid stored config as absent rather than throwing at the read path', () => {
    expect(parseCancellationPolicyConfig({ tiers: 'nope' })).toBeNull();
    expect(parseCancellationPolicyConfig(null)).toBeNull();
  });

  it('round-trips a valid one', () => {
    expect(parseCancellationPolicyConfig(VALID)).toEqual(VALID);
  });
});
