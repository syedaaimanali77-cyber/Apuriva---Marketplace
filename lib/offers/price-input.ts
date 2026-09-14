/**
 * Spec 018 §5 — turns the provider's typed price ("3200" or "3200.50") into integer minor units using
 * string/integer arithmetic only (master spec §132.5: no floating point for money). Assumes a two-digit
 * minor unit, the same convention `components/PriceDisplay.tsx` already formats with. Returns `null`
 * for anything the server would reject, so the form can say so before submitting; the server still
 * validates independently.
 */
import { MAX_PRICE_MINOR_UNITS } from './validation';

export function parseMajorAmountToMinorUnits(input: string): number | null {
  const match = /^\s*(\d{1,8})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!match) return null;
  const minor = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return minor > 0 && minor <= MAX_PRICE_MINOR_UNITS ? minor : null;
}

/** Display only: minor units back to a plain "3200.50" string. */
export function formatMinorUnits(amountMinorUnits: number): string {
  const whole = Math.trunc(amountMinorUnits / 100);
  const fraction = String(amountMinorUnits % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}
