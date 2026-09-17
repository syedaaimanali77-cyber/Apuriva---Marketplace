import { withApiRoute } from '@/lib/api/handler';
import { apiPaged } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { listConversationMessagesForAdmin, requireConversationReadPermission, validateAdminReason } from '@/lib/messaging';
import { conversationIdFromUrl } from '../../conversation-id';

/**
 * Spec 025 §3, `GET /api/v1/admin/conversations/{id}/messages?reason=...` (AC-5) — carries bodies, so
 * every PAGE writes its own audit event. The same guard order as `GET /admin/conversations/{id}`.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('messaging', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  await requireConversationReadPermission(session.userId);
  const searchParams = new URL(request.url).searchParams;
  const reason = validateAdminReason(searchParams.get('reason'));

  const result = await listConversationMessagesForAdmin(
    { adminUserId: session.userId, conversationId: conversationIdFromUrl(request, 1), reason, correlationId },
    searchParams,
  );
  return apiPaged(result.data, result.page, correlationId);
});
