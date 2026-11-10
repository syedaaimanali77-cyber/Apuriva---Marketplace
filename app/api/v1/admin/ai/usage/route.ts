import { withApiRoute } from '@/lib/api/handler';
import { rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { apiSuccess } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { getAiUsageSummary, requireAiUsagePermission } from '@/lib/ai';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 366;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `from`/`to` are UTC calendar dates: no single timezone applies across a whole platform's usage. */
function parseDate(value: string | null, field: string): Date | null {
  if (value === null || value === '') return null;
  if (!ISO_DATE.test(value)) throw validationError([{ field, message: 'must be a date (YYYY-MM-DD)' }]);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw validationError([{ field, message: 'must be a date (YYYY-MM-DD)' }]);
  return parsed;
}

/**
 * Spec 033 §3.2/AC-6, `GET /api/v1/admin/ai/usage?from=&to=` — requires `ai/read_usage` (Analytics,
 * Finance and Super Admins only). AGGREGATE ONLY: the payload carries no user identifier, no guest
 * hash, no input fingerprint, no prompt and no response. Identifying a specific abusive subject is
 * spec 038's job, from the `ai.abuse_signal` rows in `security_events`.
 *
 * Read-only, so no CSRF (the double-submit check guards state-changing requests, spec 005 §3).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const limit = checkRateLimit('default', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  await requireAiUsagePermission(session.userId);

  const params = new URL(request.url).searchParams;
  const to = parseDate(params.get('to'), 'to') ?? new Date();
  const from = parseDate(params.get('from'), 'from') ?? new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);

  if (from.getTime() >= to.getTime()) {
    throw validationError([{ field: 'from', message: 'must be before to' }]);
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw validationError([{ field: 'from', message: `must be within ${MAX_RANGE_DAYS} days of to` }]);
  }

  return apiSuccess(await getAiUsageSummary({ from, to }), correlationId);
});
