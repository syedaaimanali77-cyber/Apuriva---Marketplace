import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { readNoShowReportForAdmin, requireNoShowReadPermission } from '@/lib/no-show';

function reportIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1]!);
}

/**
 * Spec 023 §3, `GET /api/v1/admin/no-show-reports/{id}` — the full evidence bundle for review.
 *
 * This is the ONLY surface on which the evidence bundle, either party's statement and the coarse
 * location signal are visible, and it is gated on `no_show_reports/read`. A participant route can
 * never reach this projection (AC-10).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  await requireNoShowReadPermission(session.userId);

  const report = await readNoShowReportForAdmin(reportIdFromUrl(request));
  return apiSuccess(report, correlationId);
});
