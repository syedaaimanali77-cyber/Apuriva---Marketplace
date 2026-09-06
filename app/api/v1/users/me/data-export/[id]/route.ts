import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession } from '@/lib/auth/require-session';
import { getExportStatusDto } from '@/lib/privacy/export';

/** Extracted from the URL directly — see the same note in .../sessions/[id]/route.ts. */
function exportIdFromUrl(request: Request): string {
  const segments = new URL(request.url).pathname.split('/').filter(Boolean);
  return decodeURIComponent(segments[segments.length - 1]!);
}

/**
 * Spec 008 AC-3, `GET /api/v1/users/me/data-export/{id}` — `id` must belong to the caller; a
 * nonexistent or another user's export request returns the same `404 NOT_FOUND` either way.
 * `downloadUrl` is present only once `status` is `ready` (lib/privacy/export.ts).
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const exportRequestId = exportIdFromUrl(request);
  const dto = await getExportStatusDto(session.userId, exportRequestId);
  return apiSuccess(dto, correlationId);
});
