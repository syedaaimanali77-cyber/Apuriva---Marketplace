/**
 * Spec 040 §3.5/§3.6 — the reporting window W = [from, to) and the rounding every formula uses.
 */
import { validationError } from '@/lib/api/errors';

export const DEFAULT_RANGE_DAYS = 30;
export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

export interface ReportRange {
  from: Date;
  to: Date;
}

function parseInstant(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `from`/`to` query parameters → W. Defaults: `to` = now, `from` = `to` − 30 days. Throws `400`. */
export function parseReportRange(params: URLSearchParams, now: Date = new Date()): ReportRange {
  const errors: { field: string; message: string }[] = [];
  const rawTo = params.get('to');
  const rawFrom = params.get('from');
  const to = rawTo === null ? now : parseInstant(rawTo);
  if (!to) errors.push({ field: 'to', message: 'Must be an ISO-8601 date or instant.' });
  const from = rawFrom === null ? (to ? new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS) : null) : parseInstant(rawFrom);
  if (!from) errors.push({ field: 'from', message: 'Must be an ISO-8601 date or instant.' });
  if (from && to) {
    if (from.getTime() >= to.getTime()) errors.push({ field: 'from', message: 'Must be earlier than `to`.' });
    else if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      errors.push({ field: 'from', message: `The range may span at most ${MAX_RANGE_DAYS} days.` });
    }
  }
  if (errors.length > 0) throw validationError(errors);
  return { from: from!, to: to! };
}

/** The equal-length window immediately before W (retention, service trends). */
export function previousRange(range: ReportRange): ReportRange {
  const span = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - span), to: range.from };
}

/** `numerator / denominator` rounded to `places`, or `null` when the denominator is 0. */
export function ratio(numerator: number, denominator: number, places: number): number | null {
  if (denominator === 0) return null;
  return round(numerator / denominator, places);
}

export function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
