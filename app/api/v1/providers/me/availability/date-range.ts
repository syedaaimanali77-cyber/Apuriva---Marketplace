/**
 * Spec 016 §3 — shared `?from=&to=` parsing for the overrides and slots reads.
 *
 * A malformed or inverted range is a SHAPE failure, so it is `400 VALIDATION_ERROR`, not the
 * `422 INVALID_SCHEDULE_RANGE` that R6 reserves for domain-rule violations (§3 error table).
 *
 * Lives outside `route.ts` because a Next.js route module may export nothing but its HTTP
 * methods — the same reason `app/api/v1/requests/request-id.ts` is its own file.
 */
import { validationError } from '@/lib/api/errors';
import { MAX_RANGE_DAYS } from '@/lib/availability/owner';
import { daysBetween, isValidDateString } from '@/lib/availability/timezone';

export function parseDateRange(request: Request): { from: string; to: string } {
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  if (!isValidDateString(from) || !isValidDateString(to)) {
    throw validationError([
      { field: 'from', message: 'is required and must be a real calendar date in YYYY-MM-DD form.' },
      { field: 'to', message: 'is required and must be a real calendar date in YYYY-MM-DD form.' },
    ]);
  }

  const span = daysBetween(from, to);
  if (span < 0) throw validationError([{ field: 'to', message: 'must not be before from.' }]);
  if (span >= MAX_RANGE_DAYS) {
    throw validationError([{ field: 'to', message: `must be within ${MAX_RANGE_DAYS} days of from.` }]);
  }
  return { from, to };
}
