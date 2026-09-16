/**
 * Spec 023 §3 "Policy model" — the policy configuration grammar, and the platform default.
 *
 * WRITE-TIME VALIDATION IS THE POINT. A malformed ladder can never be persisted, so every read path
 * downstream can treat a stored config as well-formed rather than defensively re-deriving it. The
 * database holds a structural floor (`policy_versions_config_ck`: an object, with a non-empty
 * `tiers` array); the full grammar lives here — exactly the split spec 017 uses for
 * `matching_weights` (`services_matching_pool_size_ck` at the database, `validateMatchingWeights`
 * in code).
 */
import type {
  CancellationPolicyConfig,
  CancellationPolicyOption,
  CancellationTier,
} from '@/lib/types/cancellation';
import { policyConfigInvalidError, type FieldError } from './errors';

/**
 * Spec 023 §3 "The platform default" — the seeded ladder, as a Product decision.
 *
 * Master spec §50 gives an EXAMPLE (">24h free / 12–24h small fee / <12h higher fee") and no exact
 * numbers, so these were decided in the approved spec rather than left open: 0 / 25 / 50 / 100 is
 * the simplest monotone ladder satisfying §50's shape, and — being a percentage of what was
 * actually captured — can never exceed what the customer paid.
 *
 * This constant must stay IDENTICAL to what `0019_add_cancellation_policy_no_show.sql` seeds;
 * `policy-config.test.ts` asserts the exact ladder so the two can never drift silently. It is a
 * default, not a constant of the system: an admin changes it by publishing a new version.
 */
export const PLATFORM_DEFAULT_CANCELLATION_CONFIG: CancellationPolicyConfig = {
  tiers: [
    { minHoursBefore: 24, maxHoursBefore: null, feePercent: 0 },
    { minHoursBefore: 12, maxHoursBefore: 24, feePercent: 25 },
    { minHoursBefore: 0, maxHoursBefore: 12, feePercent: 50 },
    { minHoursBefore: null, maxHoursBefore: 0, feePercent: 100 },
  ],
  allowedOptions: [],
};

const OPTION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isBoundValue(value: unknown): value is number | null {
  return value === null || isInteger(value);
}

/**
 * Validates one ladder. Shared by the top-level `tiers` and by every `allowedOptions[].tiers`, so a
 * provider-selectable option can never be laxer than the policy it belongs to.
 *
 * The rules, in the order they are checked:
 *   1. a non-empty array;
 *   2. every bound an integer or null, every `feePercent` an integer 0–100;
 *   3. ordered by DESCENDING `minHoursBefore` (furthest-out tier first), with the first tier
 *      unbounded above and the last unbounded below — so the ladder is exhaustive;
 *   4. contiguous: each tier's lower bound is the next tier's upper bound, leaving no gap or
 *      overlap where an instant would match two tiers or none;
 *   5. `feePercent` non-decreasing as the booking approaches, because a ladder that got CHEAPER
 *      closer to the appointment would reward late cancellation.
 */
function validateTiers(value: unknown, field: string, errors: FieldError[]): CancellationTier[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ field, message: 'must be a non-empty array of tiers' });
    return null;
  }

  const tiers: CancellationTier[] = [];
  let shapeOk = true;

  for (const [index, raw] of value.entries()) {
    const at = `${field}[${index}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push({ field: at, message: 'must be an object' });
      shapeOk = false;
      continue;
    }
    const tier = raw as Record<string, unknown>;
    if (!isBoundValue(tier.minHoursBefore)) {
      errors.push({ field: `${at}.minHoursBefore`, message: 'must be an integer number of hours or null' });
      shapeOk = false;
    }
    if (!isBoundValue(tier.maxHoursBefore)) {
      errors.push({ field: `${at}.maxHoursBefore`, message: 'must be an integer number of hours or null' });
      shapeOk = false;
    }
    if (!isInteger(tier.feePercent) || (tier.feePercent as number) < 0 || (tier.feePercent as number) > 100) {
      errors.push({ field: `${at}.feePercent`, message: 'must be an integer from 0 to 100' });
      shapeOk = false;
    }
    if (shapeOk) {
      tiers.push({
        minHoursBefore: tier.minHoursBefore as number | null,
        maxHoursBefore: tier.maxHoursBefore as number | null,
        feePercent: tier.feePercent as number,
      });
    }
  }

  if (!shapeOk) return null;

  if (tiers[0]!.maxHoursBefore !== null) {
    errors.push({ field: `${field}[0].maxHoursBefore`, message: 'must be null: the first tier is unbounded above' });
  }
  if (tiers[tiers.length - 1]!.minHoursBefore !== null) {
    errors.push({
      field: `${field}[${tiers.length - 1}].minHoursBefore`,
      message: 'must be null: the last tier covers the scheduled time and everything after it',
    });
  }

  for (let i = 0; i < tiers.length - 1; i += 1) {
    const current = tiers[i]!;
    const next = tiers[i + 1]!;
    if (current.minHoursBefore === null || next.maxHoursBefore === null) {
      errors.push({ field: `${field}[${i + 1}]`, message: 'only the first and last tier may be unbounded' });
      continue;
    }
    if (current.minHoursBefore !== next.maxHoursBefore) {
      errors.push({
        field: `${field}[${i + 1}].maxHoursBefore`,
        message: `must equal the previous tier's minHoursBefore (${current.minHoursBefore}) so the ladder has no gap`,
      });
    }
    if (next.feePercent < current.feePercent) {
      errors.push({
        field: `${field}[${i + 1}].feePercent`,
        message: 'must not be lower than the previous tier: a later cancellation can never cost less',
      });
    }
  }

  return errors.length === 0 ? tiers : null;
}

function validateOptions(value: unknown, errors: FieldError[]): CancellationPolicyOption[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ field: 'allowedOptions', message: 'must be an array' });
    return null;
  }

  const options: CancellationPolicyOption[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of value.entries()) {
    const at = `allowedOptions[${index}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      errors.push({ field: at, message: 'must be an object' });
      continue;
    }
    const option = raw as Record<string, unknown>;
    if (typeof option.key !== 'string' || !OPTION_KEY_PATTERN.test(option.key)) {
      errors.push({ field: `${at}.key`, message: 'must be a lowercase identifier of at most 32 characters' });
      continue;
    }
    if (seen.has(option.key)) {
      errors.push({ field: `${at}.key`, message: 'is duplicated' });
      continue;
    }
    seen.add(option.key);
    const tiers = validateTiers(option.tiers, `${at}.tiers`, errors);
    if (tiers) options.push({ key: option.key, tiers });
  }

  return errors.length === 0 ? options : null;
}

/**
 * Parses and validates a policy configuration, throwing `422 POLICY_CONFIG_INVALID` with an
 * `errors[]` array naming every offending field.
 *
 * Used on the admin publish path AND when reading a stored version back: a row that somehow fails
 * validation is treated as absent rather than trusted, which is what makes "configuration is
 * invalid" a decided case instead of undefined behaviour (§3 "Precedence").
 */
export function validateCancellationPolicyConfig(value: unknown): CancellationPolicyConfig {
  const errors: FieldError[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw policyConfigInvalidError([{ field: 'config', message: 'must be an object' }]);
  }

  const record = value as Record<string, unknown>;
  const tiers = validateTiers(record.tiers, 'tiers', errors);
  const allowedOptions = validateOptions(record.allowedOptions, errors);

  if (errors.length > 0 || !tiers || !allowedOptions) throw policyConfigInvalidError(errors);
  return { tiers, allowedOptions };
}

/** Non-throwing form, for read paths that must treat an invalid stored config as absent. */
export function parseCancellationPolicyConfig(value: unknown): CancellationPolicyConfig | null {
  try {
    return validateCancellationPolicyConfig(value);
  } catch {
    return null;
  }
}
