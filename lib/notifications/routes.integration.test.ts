import { beforeEach, describe, expect, it } from 'vitest';
import { GET as LIST } from '@/app/api/v1/users/me/notifications/route';
import { GET as UNREAD_COUNT } from '@/app/api/v1/users/me/notifications/unread-count/route';
import { POST as MARK_READ } from '@/app/api/v1/users/me/notifications/[id]/read/route';
import { POST as READ_ALL } from '@/app/api/v1/users/me/notifications/read-all/route';
import { GET as GET_PREFS, PATCH as PATCH_PREFS } from '@/app/api/v1/users/me/notification-preferences/route';
import { POST as CONSENT } from '@/app/api/v1/users/me/marketing-consent/route';
import * as notificationsRoute from '@/app/api/v1/users/me/notifications/route';
import { OPENAPI_ROUTES } from '@/lib/api/openapi-registry';
import { resetRateLimitState } from '@/lib/api/rate-limit';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { authenticatedRequest, isDatabaseReachable, registerAndLogin } from '@/app/api/v1/search/search-test-support';
import { notify } from './create';

const dbReachable = await isDatabaseReachable();
const BASE = 'http://localhost/api/v1/users/me';

type Session = Awaited<ReturnType<typeof registerAndLogin>>;

const get = (url: string, s: Session) => authenticatedRequest(url, s.sessionId, s.csrfToken, { method: 'GET' });
const post = (url: string, s: Session, body?: unknown) => authenticatedRequest(url, s.sessionId, s.csrfToken, { method: 'POST', body });
const patch = (url: string, s: Session, body: unknown) => authenticatedRequest(url, s.sessionId, s.csrfToken, { method: 'PATCH', body });
/** A session cookie but no CSRF header. */
const noCsrf = (url: string, s: Session, method: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${s.sessionId}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function seed(userId: string, count: number, prefix = 'seed'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = await notify({ recipientUserId: userId, type: 'no_show_reported', eventKey: `${prefix}:${i}` });
    if (result.status !== 'created') throw new Error('expected created');
    ids.push(result.notification.id);
  }
  return ids;
}

/** Spec 026 AC-2, AC-8, AC-9 and §3 "Endpoints" — the browser routes. */
describe.skipIf(!dbReachable)('notification routes (spec 026, integration)', () => {
  beforeEach(() => resetRateLimitState());

  it('session required on every route', async () => {
    const anonymous = (url: string, method = 'GET') => new Request(url, { method });
    for (const res of [
      await LIST(anonymous(`${BASE}/notifications`)),
      await UNREAD_COUNT(anonymous(`${BASE}/notifications/unread-count`)),
      await MARK_READ(anonymous(`${BASE}/notifications/00000000-0000-0000-0000-000000000000/read`, 'POST')),
      await READ_ALL(anonymous(`${BASE}/notifications/read-all`, 'POST')),
      await GET_PREFS(anonymous(`${BASE}/notification-preferences`)),
      await PATCH_PREFS(anonymous(`${BASE}/notification-preferences`, 'PATCH')),
      await CONSENT(anonymous(`${BASE}/marketing-consent`, 'POST')),
    ]) {
      expect(res.status).toBe(401);
    }
  });

  it('CSRF on every mutation', async () => {
    const user = await registerAndLogin();
    const [id] = await seed(user.userId, 1, 'csrf');
    for (const res of [
      await MARK_READ(noCsrf(`${BASE}/notifications/${id}/read`, user, 'POST')),
      await READ_ALL(noCsrf(`${BASE}/notifications/read-all`, user, 'POST')),
      await PATCH_PREFS(noCsrf(`${BASE}/notification-preferences`, user, 'PATCH', { categories: {}, version: 0 })),
      await CONSENT(noCsrf(`${BASE}/marketing-consent`, user, 'POST', { consent: true })),
    ]) {
      expect(res.status).toBe(403);
    }
    // Nothing changed.
    const count = await (await UNREAD_COUNT(get(`${BASE}/notifications/unread-count`, user))).json();
    expect(count.data).toEqual({ unread: 1 });
  });

  it("lists only the caller's notifications in created_at DESC, id DESC", async () => {
    const [alice, bob] = [await registerAndLogin(), await registerAndLogin()];
    const aliceIds = await seed(alice.userId, 3, 'order');
    await seed(bob.userId, 2, 'order');

    const res = await LIST(get(`${BASE}/notifications`, alice));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((n: { id: string }) => n.id)).toEqual([...aliceIds].reverse());
    expect(body.page).toEqual({ limit: 20, offset: 0, total: 3, nextOffset: null });
    const createdAt = body.data.map((n: { createdAt: string }) => n.createdAt);
    expect([...createdAt].sort().reverse()).toEqual(createdAt);
    expect(Object.keys(body.data[0]).sort()).toEqual(['body', 'category', 'createdAt', 'id', 'readAt', 'title', 'type']);
  });

  it('pagination neither repeats nor skips, even when rows share created_at', async () => {
    const user = await registerAndLogin();
    const ids = await seed(user.userId, 7, 'page');
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const body: { data: Array<{ id: string }>; page: { nextOffset: number | null } } = await (
        await LIST(get(`${BASE}/notifications?limit=3&offset=${offset}`, user))
      ).json();
      seen.push(...body.data.map((n) => n.id));
      offset = body.page.nextOffset;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('unreadOnly filters, unread-count counts, mark read is idempotent, read-all returns the count', async () => {
    const user = await registerAndLogin();
    const ids = await seed(user.userId, 4, 'unread');

    const first = await MARK_READ(post(`${BASE}/notifications/${ids[0]}/read`, user));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data.readAt).not.toBeNull();
    const again = await MARK_READ(post(`${BASE}/notifications/${ids[0]}/read`, user));
    expect(again.status).toBe(200);
    expect((await again.json()).data.readAt).toBe(firstBody.data.readAt);

    const unreadList = await (await LIST(get(`${BASE}/notifications?unreadOnly=true`, user))).json();
    expect(unreadList.data.map((n: { id: string }) => n.id).sort()).toEqual(ids.slice(1).sort());
    expect((await (await UNREAD_COUNT(get(`${BASE}/notifications/unread-count`, user))).json()).data).toEqual({ unread: 3 });

    const all = await READ_ALL(post(`${BASE}/notifications/read-all`, user));
    expect((await all.json()).data).toEqual({ updated: 3 });
    expect((await (await READ_ALL(post(`${BASE}/notifications/read-all`, user))).json()).data).toEqual({ updated: 0 });
    expect((await (await UNREAD_COUNT(get(`${BASE}/notifications/unread-count`, user))).json()).data).toEqual({ unread: 0 });
    // Reading is not reversible and the instant never shifts.
    expect((await (await MARK_READ(post(`${BASE}/notifications/${ids[0]}/read`, user))).json()).data.readAt).toBe(firstBody.data.readAt);
  });

  it("another user's notification is 404", async () => {
    const [alice, bob] = [await registerAndLogin(), await registerAndLogin()];
    const [bobId] = await seed(bob.userId, 1, 'probe');
    for (const id of [bobId, '11111111-1111-1111-1111-111111111111', 'not-a-uuid']) {
      const res = await MARK_READ(post(`${BASE}/notifications/${id}/read`, alice));
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe('NOTIFICATION_NOT_FOUND');
    }
    // Bob's notification is untouched.
    expect((await (await UNREAD_COUNT(get(`${BASE}/notifications/unread-count`, bob))).json()).data).toEqual({ unread: 1 });
  });

  it('preferences: defaults with version 0, a successful update, and 409 on a stale version', async () => {
    const user = await registerAndLogin();
    const initial = (await (await GET_PREFS(get(`${BASE}/notification-preferences`, user))).json()).data;
    expect(initial.version).toBe(0);
    expect(initial.marketingConsentAt).toBeNull();
    expect(initial.nonOverridableCategories).toEqual(['security', 'payments', 'operational']);
    expect(initial.categories.security).toEqual({ email: true, push: false, sms: false });
    expect(initial.categories.booking).toEqual({ email: false, push: false, sms: false });

    const updated = await PATCH_PREFS(patch(`${BASE}/notification-preferences`, user, { categories: { booking: { push: true }, security: { sms: true } }, version: 0 }));
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()).data;
    expect(updatedBody.version).toBe(1);
    expect(updatedBody.categories.booking).toEqual({ email: false, push: true, sms: false });
    expect(updatedBody.categories.security).toEqual({ email: true, push: false, sms: true });

    const stale = await PATCH_PREFS(patch(`${BASE}/notification-preferences`, user, { categories: { booking: { push: false } }, version: 0 }));
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('CONFLICT');
  });

  it('disabling a non-overridable category is 422', async () => {
    const user = await registerAndLogin();
    for (const category of ['security', 'payments', 'operational']) {
      const res = await PATCH_PREFS(
        patch(`${BASE}/notification-preferences`, user, { categories: { booking: { email: true }, [category]: { email: false } }, version: 0 }),
      );
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('CATEGORY_NOT_OVERRIDABLE');
      expect(body.details).toEqual({ category });
    }
    // Nothing was changed — not even the valid part of the request.
    const prefs = (await (await GET_PREFS(get(`${BASE}/notification-preferences`, user))).json()).data;
    expect(prefs.version).toBe(0);
    expect(prefs.categories.booking.email).toBe(false);
  });

  it('400 on unknown categories, channels and non-booleans', async () => {
    const user = await registerAndLogin();
    for (const body of [
      { categories: { marketing: { email: true } }, version: 0 },
      { categories: { booking: { in_app: false } }, version: 0 },
      { categories: { booking: { email: 'yes' } }, version: 0 },
      { categories: [], version: 0 },
      { categories: {}, version: 'x' },
    ]) {
      const res = await PATCH_PREFS(patch(`${BASE}/notification-preferences`, user, body));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('VALIDATION_ERROR');
    }
  });

  it('marketing consent: grant, idempotent repeat, withdraw, and validation', async () => {
    const user = await registerAndLogin();
    const granted = (await (await CONSENT(post(`${BASE}/marketing-consent`, user, { consent: true }))).json()).data;
    expect(granted.marketingConsentAt).not.toBeNull();
    const repeat = (await (await CONSENT(post(`${BASE}/marketing-consent`, user, { consent: true }))).json()).data;
    expect(repeat.marketingConsentAt).toBe(granted.marketingConsentAt);
    const prefs = (await (await GET_PREFS(get(`${BASE}/notification-preferences`, user))).json()).data;
    expect(prefs.marketingConsentAt).toBe(granted.marketingConsentAt);
    expect((await (await CONSENT(post(`${BASE}/marketing-consent`, user, { consent: false }))).json()).data).toEqual({ marketingConsentAt: null });
    expect((await CONSENT(post(`${BASE}/marketing-consent`, user, { consent: 'yes' }))).status).toBe(400);
  });

  it('rate limited through the default domain', async () => {
    const user = await registerAndLogin();
    let last = 200;
    for (let i = 0; i < 101; i += 1) last = (await UNREAD_COUNT(get(`${BASE}/notifications/unread-count`, user))).status;
    expect(last).toBe(429);
  });

  it('no route can create a notification', () => {
    expect(Object.keys(notificationsRoute)).toEqual(['GET']);
    expect(OPENAPI_ROUTES.filter((r) => r.path.startsWith('/users/me/notifications') && r.method === 'POST').map((r) => r.path).sort()).toEqual([
      '/users/me/notifications/read-all',
      '/users/me/notifications/{id}/read',
    ]);
  });

  it('OpenAPI: all seven browser routes registered and tagged notifications; the cron route deliberately absent', () => {
    const tagged = OPENAPI_ROUTES.filter((r) => r.tags.includes('notifications')).map((r) => `${r.method} ${r.path}`);
    expect(tagged.sort()).toEqual(
      [
        'GET /users/me/notifications',
        'GET /users/me/notifications/unread-count',
        'POST /users/me/notifications/{id}/read',
        'POST /users/me/notifications/read-all',
        'GET /users/me/notification-preferences',
        'PATCH /users/me/notification-preferences',
        'POST /users/me/marketing-consent',
      ].sort(),
    );
    expect(OPENAPI_ROUTES.some((r) => r.path.includes('notification-dispatch-sweep'))).toBe(false);
  });
});
