import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError } from '@/lib/api/errors';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { issueStepUpToken } from '@/lib/auth/step-up';

/**
 * Spec 005 AC-6, `POST /api/v1/auth/step-up` — short-lived token bound to the specific sensitive
 * `action` the caller names, for a later domain endpoint (e.g. spec 024's payout-method change)
 * to require and verify before proceeding.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  if (typeof body.action !== 'string' || body.action.trim() === '') {
    throw validationError([{ field: 'action', message: 'is required' }]);
  }

  const { stepUpToken, expiresAt } = issueStepUpToken(session.id, body.action);
  return apiSuccess({ stepUpToken, expiresAt: expiresAt.toISOString() }, correlationId);
});
