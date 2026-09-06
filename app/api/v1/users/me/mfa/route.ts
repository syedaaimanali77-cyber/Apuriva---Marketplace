import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError } from '@/lib/api/errors';
import { requireSession, requireCsrf } from '@/lib/auth/require-session';
import { requireStepUp } from '@/lib/auth/step-up';
import { recordSecurityEvent } from '@/lib/auth/security-event';
import { getMfaEnabled, setMfaEnabled } from '@/lib/privacy/mfa';
import type { MfaToggleRequest } from '@/lib/types/privacy';

const STEP_UP_ACTION = 'toggle_mfa';

/** Read side of the same Security Center control — not a sensitive action, no step-up needed
 * to merely see current state (only PATCH changes it). */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  const mfaEnabled = await getMfaEnabled(session.userId);
  return apiSuccess({ mfaEnabled }, correlationId);
});

/**
 * Spec 008 D, `PATCH /api/v1/users/me/mfa` — the Security Center's MFA on/off control. Toggles
 * only the enrollment state spec 005 already owns (lib/privacy/mfa.ts); never enrolls/generates a
 * secret itself (that stays spec 005's job, out of scope here per spec 008 §7).
 */
export const PATCH = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  requireStepUp(request, session, STEP_UP_ACTION);

  const body = (await request.json().catch(() => ({}))) as Partial<MfaToggleRequest>;
  if (typeof body.enabled !== 'boolean') {
    throw validationError([{ field: 'enabled', message: 'must be a boolean' }]);
  }

  const result = await setMfaEnabled(session.userId, body.enabled);
  await recordSecurityEvent({
    userId: session.userId,
    eventType: result.mfaEnabled ? 'privacy.mfa_enabled' : 'privacy.mfa_disabled',
    severity: 'info',
  });

  return apiSuccess(result, correlationId);
});
