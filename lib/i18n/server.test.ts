/**
 * Spec 042 §3.3/§3.4 — `lib/i18n/server.ts` degrades to `en` rather than failing a render or a route: a
 * flag read that throws counts as "unavailable", a failed user lookup as "no saved locale", and an
 * invalid session as a guest. (The happy paths run against the real database in the route tests.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  flag: false as boolean | 'throw',
  savedLocale: null as string | null | 'throw',
  session: 'none' as 'none' | 'valid' | 'invalid' | 'throw',
}));

vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: vi.fn(async () => {
    if (state.flag === 'throw') throw new Error('flag store down');
    return state.flag;
  }),
}));
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: async () => {
          if (state.savedLocale === 'throw') throw new Error('db down');
          return [{ locale: state.savedLocale }];
        },
      }),
    }),
  }),
}));
vi.mock('@/lib/auth/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/session')>()),
  validateAndRefreshSession: vi.fn(async () => {
    if (state.session === 'throw') throw new Error('session store down');
    return state.session === 'valid' ? { valid: true, session: { userId: 'user-1' } } : { valid: false, reason: 'not_found' };
  }),
}));

const { loadLocaleAvailability, readSavedUserLocale, resolveLocaleForRequest, resolveLocaleForUser } = await import('./server');

const withSession = (extra = '') => new Request('http://localhost/', { headers: { cookie: `apuriva_session=s1${extra}` } });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.flag = true;
  state.savedLocale = null;
  state.session = 'valid';
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('lib/i18n/server degradation (spec 042 §3.3)', () => {
  it('a flag read that throws makes ur unavailable, logged without failing', async () => {
    state.flag = 'throw';
    const isAvailable = await loadLocaleAvailability();
    expect(isAvailable('en')).toBe(true);
    expect(isAvailable('ur')).toBe(false);
    expect(warn.mock.calls.map((c: unknown[]) => JSON.parse(String(c[0])).event)).toContain('i18n.availability_unreadable');
  });

  it('a failed saved-locale lookup counts as "no saved locale"', async () => {
    state.savedLocale = 'throw';
    expect(await readSavedUserLocale('user-1')).toBeNull();
  });

  it('resolveLocaleForUser: the saved locale while usable, else en; no user → en', async () => {
    state.savedLocale = 'ur';
    expect(await resolveLocaleForUser('user-1')).toBe('ur');
    state.flag = false;
    expect(await resolveLocaleForUser('user-1')).toBe('en');
    expect(await resolveLocaleForUser(null)).toBe('en');
  });

  it('resolveLocaleForRequest looks the session up itself when no user id is passed', async () => {
    state.savedLocale = 'ur';
    expect(await resolveLocaleForRequest(withSession())).toEqual({ locale: 'ur', direction: 'rtl' });
  });

  it('an invalid or unreadable session is a guest: cookie → Accept-Language → en', async () => {
    state.savedLocale = 'ur';
    state.session = 'invalid';
    expect((await resolveLocaleForRequest(withSession())).locale).toBe('en');
    state.session = 'throw';
    expect((await resolveLocaleForRequest(withSession('; apuriva_locale=ur'))).locale).toBe('ur');
  });

  it('a passed null user id skips the session lookup entirely', async () => {
    state.savedLocale = 'ur';
    expect(await resolveLocaleForRequest(withSession(), null)).toEqual({ locale: 'en', direction: 'ltr' });
  });
});
