import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { rateLimitedError, validationError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { setSessionCookies } from '@/lib/auth/cookies';
import { hashRequestIp } from '@/lib/auth/ip-hash';
import { completeLogin } from '@/lib/auth/login-flow';
import { assertDemoAvailable } from '@/lib/demo/guards';
import { provisionDemoSet } from '@/lib/demo/provision';
import { DEMO_PERSONAS, type DemoPersona } from '@/lib/types/demo';

/**
 * Spec 045 D1, `POST /api/v1/demo/login` — guest. Provisions a fresh, private demo set and signs the visitor in
 * as its persona user (AC-1). Order (§3.2, §3.6): the demo-environment checks, before any domain read or
 * write; `persona` (`admin` is refused — there is no admin persona, D-2); the `auth` rate-limit bucket; one
 * provisioning transaction; then spec 005's single login choke point, `completeLogin()`, whose admin-MFA rule
 * is unchanged, and the same cookies every login route sets.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  await assertDemoAvailable();

  const body = (await request.json().catch(() => ({}))) as { persona?: unknown };
  if (!(DEMO_PERSONAS as readonly unknown[]).includes(body.persona)) {
    throw validationError([{ field: 'persona', message: `must be one of: ${DEMO_PERSONAS.join(', ')}` }]);
  }
  const persona = body.persona as DemoPersona;

  const ipHash = hashRequestIp(request);
  const limit = checkRateLimit('auth', `demo-login:ip:${ipHash ?? 'unknown'}`);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const set = await provisionDemoSet(persona);

  const { session, dto } = await completeLogin(set.personaUserId, 'demo', {
    ipHash,
    deviceLabel: request.headers.get('user-agent'),
  });

  console.log(JSON.stringify({ event: 'demo.set_provisioned', persona, demoSetId: set.setId }));

  const res = apiSuccess(dto, correlationId);
  setSessionCookies(res, session.id, session.expiresAt);
  return res;
});
