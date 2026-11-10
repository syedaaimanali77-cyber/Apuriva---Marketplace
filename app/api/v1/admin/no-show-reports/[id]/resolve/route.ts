import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError } from '@/lib/api/errors';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { resolveNoShowReport } from '@/lib/no-show';
import { NO_SHOW_OUTCOMES, type NoShowOutcome } from '@/lib/types/no-show';

const MAX_REASON_LENGTH = 2000;

function reportIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 2]!);
}

/**
 * Spec 023 §3, `POST /api/v1/admin/no-show-reports/{id}/resolve` — AC-9.
 *
 * The one route that can produce a no-show consequence, and the body is deliberately narrow: an
 * `outcome` from a CLOSED set and a required `reason`. There is no amount, no fee, no refund and no
 * booking-status parameter — the financial consequence is computed by this spec from the booking's
 * own snapshotted policy version, so an admin decides WHAT HAPPENED, never what it costs.
 *
 * Authorization is spec 009's existing `no_show_reports/resolve` at the `medium` tier: one
 * authorized Trust & Safety admin, audited. No `AdminAction`, no second approval framework — and
 * spec 022's `refunds/override` remains `high` for genuinely discretionary money.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const raw = (await request.json().catch(() => null)) as { outcome?: unknown; reason?: unknown } | null;

  const errors: { field: string; message: string }[] = [];
  if (typeof raw?.outcome !== 'string' || !NO_SHOW_OUTCOMES.includes(raw.outcome as NoShowOutcome)) {
    errors.push({ field: 'outcome', message: `must be one of: ${NO_SHOW_OUTCOMES.join(', ')}` });
  }
  if (typeof raw?.reason !== 'string' || raw.reason.trim().length === 0 || raw.reason.length > MAX_REASON_LENGTH) {
    errors.push({ field: 'reason', message: `is required and must be at most ${MAX_REASON_LENGTH} characters` });
  }
  if (errors.length > 0) throw validationError(errors);

  const report = await resolveNoShowReport({
    adminUserId: session.userId,
    reportId: reportIdFromUrl(request),
    outcome: raw!.outcome as NoShowOutcome,
    reason: raw!.reason as string,
  });
  return apiSuccess(report, correlationId);
});
