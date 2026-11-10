/**
 * Spec 024 §3.3 — the earnings arithmetic. Pure, integer-only, and the ONE place a fee is computed.
 *
 * Rounding is half-up on the fee: `feeOn(base) = trunc((base * bps + 5000) / 10000)`. `feeNet` is
 * recomputed from the CUMULATIVE refunded total rather than accumulated per refund, so N partial
 * refunds give exactly the result of one refund of the same total — no drift.
 */

export const MAX_FEE_BPS = 10_000;

export class PlatformFeeUnconfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformFeeUnconfigured';
  }
}

export const PLATFORM_FEE_BPS_ENV_VAR = 'PLATFORM_FEE_BPS';

/**
 * The configured commission in basis points. No default and no silent fallback — guessing a
 * commission is how a provider is quietly underpaid, the same reason `resolvePaymentProvider()`
 * refuses an unconfigured adapter. Read fresh on every call.
 */
export function resolvePlatformFeeBps(): number {
  const raw = (process.env[PLATFORM_FEE_BPS_ENV_VAR] ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    throw new PlatformFeeUnconfigured(`${PLATFORM_FEE_BPS_ENV_VAR} must be set to an integer in [0, ${MAX_FEE_BPS}].`);
  }
  const bps = Number(raw);
  if (!Number.isSafeInteger(bps) || bps > MAX_FEE_BPS) {
    throw new PlatformFeeUnconfigured(`${PLATFORM_FEE_BPS_ENV_VAR} must be an integer in [0, ${MAX_FEE_BPS}].`);
  }
  return bps;
}

function assertMinorUnits(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of minor units`);
  }
}

function assertBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_FEE_BPS) {
    throw new RangeError(`feeBps must be an integer in [0, ${MAX_FEE_BPS}]`);
  }
}

/** Half-up fee on a non-negative base. */
export function feeOn(base: number, bps: number): number {
  assertMinorUnits(base, 'base');
  assertBps(bps);
  return Math.trunc((base * bps + 5000) / 10_000);
}

export interface LineFigures {
  /** The fee on gross — stored as `fee_amount_minor_units`, immutable. */
  feeAmountMinorUnits: number;
  refundedAmountMinorUnits: number;
  feeReversalAmountMinorUnits: number;
  netAmountMinorUnits: number;
}

/**
 * Every stored figure of an earnings line from its three authoritative inputs.
 * Guarantees: `net >= 0`, `feeReversal >= 0`, and
 * `net = gross − refunded − fee + feeReversal` (the database's I-5).
 */
export function computeLineFigures(grossAmountMinorUnits: number, feeBps: number, refundedAmountMinorUnits: number): LineFigures {
  assertMinorUnits(grossAmountMinorUnits, 'gross');
  assertMinorUnits(refundedAmountMinorUnits, 'refunded');
  if (grossAmountMinorUnits <= 0) throw new RangeError('gross must be greater than zero');
  if (refundedAmountMinorUnits > grossAmountMinorUnits) throw new RangeError('refunded cannot exceed gross');

  const feeGross = feeOn(grossAmountMinorUnits, feeBps);
  const netBase = grossAmountMinorUnits - refundedAmountMinorUnits;
  const feeNet = feeOn(netBase, feeBps);
  return {
    feeAmountMinorUnits: feeGross,
    refundedAmountMinorUnits,
    feeReversalAmountMinorUnits: feeGross - feeNet,
    netAmountMinorUnits: netBase - feeNet,
  };
}
