import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError } from '@/lib/api/errors';
import { requireSession } from '@/lib/auth/require-session';
import { listNoShowReportsForAdmin, requireNoShowReadPermission } from '@/lib/no-show';
import { NO_SHOW_OUTCOMES, NO_SHOW_STATUSES } from '@/lib/types/no-show';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * Spec 023 §3, `GET /api/v1/admin/no-show-reports` — the Trust & Safety queue.
 *
 * Behind spec 009's existing `no_show_reports/read` permission (`low` tier, seeded by `0019` for
 * `trust_safety_admin` and `super_admin`). An admin without it gets `403` — correct here rather than
 * `404`, because this is a collection route with no id to probe.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  await requireNoShowReadPermission(session.userId);

  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? undefined;
  const outcome = url.searchParams.get('outcome') ?? undefined;

  if (status && !NO_SHOW_STATUSES.includes(status as (typeof NO_SHOW_STATUSES)[number])) {
    throw validationError([{ field: 'status', message: `must be one of: ${NO_SHOW_STATUSES.join(', ')}` }]);
  }
  if (outcome && !NO_SHOW_OUTCOMES.includes(outcome as (typeof NO_SHOW_OUTCOMES)[number])) {
    throw validationError([{ field: 'outcome', message: `must be one of: ${NO_SHOW_OUTCOMES.join(', ')}` }]);
  }

  const limitParam = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const offsetParam = Number(url.searchParams.get('offset') ?? 0);
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isInteger(offsetParam) && offsetParam >= 0 ? offsetParam : 0;

  const reports = await listNoShowReportsForAdmin({ status, outcome, limit, offset });
  return apiSuccess(reports, correlationId);
});
