import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import { cancelDeletion } from '@/lib/privacy/deletion';

/**
 * Spec 008, `POST /api/v1/users/me/deletion/cancel` — only the caller's own pending deletion,
 * only within the grace period; `409 DELETION_NOT_PENDING` once anonymization has begun (or if
 * nothing was ever pending) — deletion cannot be undone after that point.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  await cancelDeletion(session.userId);
  await recordSecurityEvent({ userId: session.userId, eventType: 'privacy.deletion_cancelled', severity: 'info' });

  return apiSuccess<{ lifecycleStatus: 'active' }>({ lifecycleStatus: 'active' }, correlationId);
});
