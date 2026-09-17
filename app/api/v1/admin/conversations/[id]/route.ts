import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { requireSession } from '@/lib/auth/require-session';
import { readConversationForAdmin, requireConversationReadPermission, validateAdminReason } from '@/lib/messaging';
import { conversationIdFromUrl } from '../conversation-id';

/**
 * Spec 025 §3, `GET /api/v1/admin/conversations/{id}?reason=...` (AC-5) — metadata and participants
 * only, never message bodies. Order: session, rate limit, permission (`403`), reason (`400`), lookup
 * (`404`), audit, response — so an unauthorized admin learns nothing, and no data leaves unaudited.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('messaging', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  await requireConversationReadPermission(session.userId);
  const reason = validateAdminReason(new URL(request.url).searchParams.get('reason'));

  const conversation = await readConversationForAdmin({
    adminUserId: session.userId,
    conversationId: conversationIdFromUrl(request, 0),
    reason,
    correlationId,
  });
  return apiSuccess(conversation, correlationId);
});
