import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { createSuggestion } from '@/lib/catalog/suggestions';
import type { CreateCatalogSuggestionRequest } from '@/lib/types/catalog';

/**
 * Spec 010 §3/AC-3, `POST /api/v1/admin/catalog/suggestions` — spec 034's AI assistant, via spec
 * 035's MCP tool pipeline. Any authenticated caller (spec 035 owns that tool call's own
 * authorization, not a Content/Marketplace permission grant — submitting a suggestion never
 * mutates a catalog entity). Always created `pending_review`.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as Partial<CreateCatalogSuggestionRequest>;
  const suggestion = await createSuggestion(body as CreateCatalogSuggestionRequest);
  return apiSuccess(suggestion, correlationId, { status: 201 });
});
