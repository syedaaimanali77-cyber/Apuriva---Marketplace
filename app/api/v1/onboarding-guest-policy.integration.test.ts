import { describe, expect, it } from 'vitest';
import { GET as health } from './health/route';
import { POST as becomeProvider } from './users/me/provider-profile/route';
import { isDatabaseReachable } from './auth/test-support';

/**
 * Spec 007 AC-2/AC-3, traceability: the guest-accessible vs. identity-required route policy this
 * spec establishes (§4). Spec 007 does not add new browse/search/provider endpoints itself —
 * those are specs 010-014's contracts (§3) — so this asserts the *policy* using the routes that
 * already exist: a guest-accessible GET (health check) and an existing identity-required action
 * (`POST /users/me/provider-profile`, spec 006) that already enforces `401 UNAUTHENTICATED` for
 * an unauthenticated request via `requireSession` (spec 005).
 */
const dbReachable = await isDatabaseReachable();

describe('Guest vs. identity-required route policy (spec 007 AC-2/AC-3)', () => {
  it('AC-2: a guest-accessible route succeeds with no session at all', async () => {
    const res = await health();
    expect(res.status).toBe(200);
  });

  it.skipIf(!dbReachable)(
    'AC-3: an identity-requiring route rejects a sessionless guest with 401 UNAUTHENTICATED',
    async () => {
      const res = await becomeProvider(
        new Request('http://localhost/api/v1/users/me/provider-profile', { method: 'POST' }),
      );
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('UNAUTHENTICATED');
    },
  );
});
