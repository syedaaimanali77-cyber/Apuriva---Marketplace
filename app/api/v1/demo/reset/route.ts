import { forbiddenError, rateLimitedError } from '@/lib/api/errors';
import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { setSessionCookies } from '@/lib/auth/cookies';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { completeLogin } from '@/lib/auth/login-flow';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { revokeSession } from '@/lib/auth/session';
import { assertDemoAvailable } from '@/lib/demo/guards';
import { provisionDemoSet } from '@/lib/demo/provision';
import { readDemoUserContext } from '@/lib/demo/users';

/**
 * Spec 045 D2, `POST /api/v1/demo/reset` — session + CSRF, demo users only (AC-5).
 *
 * A reset provisions a NEW set for the same persona and switches the session to its persona user. It never
 * updates or deletes an existing row: the old set stays as it was (removed only by the operator's reseed of
 * the whole `_demo` database), so no other visitor's set and no non-demo data can be affected. The only
 * existing row written is the caller's own session, revoked through spec 005's normal path.
 *
 * Provisioning runs BEFORE the revocation: a failure leaves nothing written and the caller's current session
 * valid — never a partially reset demo (§3.2 "Error handling").
 */
export const POST = withApiRoute(async (request, correlationId) => {
  await assertDemoAvailable();

  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const context = await readDemoUserContext(session.userId);
  if (!context?.isDemo) throw forbiddenError('Only a demo account can be reset.');

  const ipHash = hashRequestIp(request);
  const limit = checkRateLimit('auth', `demo-reset:ip:${ipHash ?? 'unknown'}`);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const set = await provisionDemoSet(context.persona);

  await revokeSession(session.id, 'demo_reset');
  const { session: replacement, dto } = await completeLogin(set.personaUserId, 'demo', {
    ipHash,
    deviceLabel: request.headers.get('user-agent'),
  });

  console.log(
    JSON.stringify({ event: 'demo.reset', persona: context.persona, previousDemoSetId: context.demoSetId, demoSetId: set.setId }),
  );

  const res = apiSuccess(dto, correlationId);
  setSessionCookies(res, replacement.id, replacement.expiresAt);
  return res;
});
