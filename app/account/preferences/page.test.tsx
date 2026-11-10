// @vitest-environment jsdom
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/dictionaries/en';
import PreferencesPage from './page';

configure({ asyncUtilTimeout: 10_000 });

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) });
const fail = (status: number) => ({ ok: false, status, json: async () => ({ code: 'INTERNAL_ERROR', message: 'boom' }) });

interface State {
  locales: string[];
  marketing: boolean;
  proactive: boolean;
  personalization: boolean;
  failWrites?: boolean;
}

/**
 * A fake of the four owning APIs, holding their state the way the server would — so a change made through the
 * hub is exactly the change the other screens (notifications, AI memory, home) read back.
 */
function stub(state: State) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      if (method !== 'GET' && state.failWrites) return fail(500);
      if (url.includes('/api/v1/locales')) {
        return ok({ locales: state.locales.map((code) => ({ code, name: code, direction: code === 'ur' ? 'rtl' : 'ltr' })), resolvedLocale: 'en', platformCurrencyCode: 'PKR' });
      }
      if (url.endsWith('/users/me/locale')) return ok({ locale: body!.locale });
      if (url.endsWith('/users/me/notification-preferences')) {
        return ok({ categories: {}, nonOverridableCategories: [], marketingConsentAt: state.marketing ? '2026-09-01T00:00:00.000Z' : null, version: 1 });
      }
      if (url.endsWith('/users/me/marketing-consent')) {
        state.marketing = body!.consent as boolean;
        return ok({ marketingConsentAt: state.marketing ? '2026-09-29T00:00:00.000Z' : null });
      }
      if (url.endsWith('/users/me/ai-preferences')) {
        if (method === 'PATCH') state.proactive = body!.proactiveSuggestionsEnabled as boolean;
        return ok({ proactiveSuggestionsEnabled: state.proactive });
      }
      if (url.endsWith('/users/me/personalization-settings')) {
        if (method === 'PATCH') state.personalization = body!.personalizationEnabled as boolean;
        return ok({ personalizationEnabled: state.personalization });
      }
      return ok({});
    }),
  );
  return calls;
}

/** The design system's Switch names itself with its label followed by its description. */
const named = (label: string) => ({ name: (accessibleName: string) => accessibleName.startsWith(label) });

const writes = (calls: ReturnType<typeof stub>) => calls.filter((c) => c.method !== 'GET');

describe('Account → Preferences hub', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows each preference as its owning system reports it', async () => {
    stub({ locales: ['en'], marketing: true, proactive: false, personalization: true });
    render(<PreferencesPage />);
    expect(await screen.findByRole('switch', named(en.accountPreferences.marketing))).toBeChecked();
    expect(await screen.findByRole('switch', named(en.accountPreferences.proactive))).not.toBeChecked();
    expect(await screen.findByRole('switch', named(en.accountPreferences.personalization))).toBeChecked();
  });

  it('notifications: toggling writes spec 026 marketing consent, and the notifications page link is there', async () => {
    const state: State = { locales: ['en'], marketing: false, proactive: true, personalization: true };
    const calls = stub(state);
    render(<PreferencesPage />);
    await userEvent.click(await screen.findByRole('switch', named(en.accountPreferences.marketing)));
    await waitFor(() => expect(screen.getByRole('switch', named(en.accountPreferences.marketing))).toBeChecked());
    expect(writes(calls)).toEqual([{ url: '/api/v1/users/me/marketing-consent', method: 'POST', body: { consent: true } }]);
    expect(state.marketing).toBe(true);
    expect(screen.getByRole('link', { name: en.accountPreferences.manageNotifications })).toHaveAttribute('href', '/account/notifications');
  });

  it('Ask Apuriva: toggling writes spec 034 ai-preferences, with the AI memory link', async () => {
    const state: State = { locales: ['en'], marketing: false, proactive: true, personalization: true };
    const calls = stub(state);
    render(<PreferencesPage />);
    await userEvent.click(await screen.findByRole('switch', named(en.accountPreferences.proactive)));
    await waitFor(() => expect(screen.getByRole('switch', named(en.accountPreferences.proactive))).not.toBeChecked());
    expect(writes(calls)).toEqual([{ url: '/api/v1/users/me/ai-preferences', method: 'PATCH', body: { proactiveSuggestionsEnabled: false } }]);
    expect(state.proactive).toBe(false);
    expect(screen.getByRole('link', { name: en.accountPreferences.manageAiMemory })).toHaveAttribute('href', '/account/ai-memory');
  });

  it('home page: toggling writes spec 014 personalization settings', async () => {
    const state: State = { locales: ['en'], marketing: false, proactive: true, personalization: true };
    const calls = stub(state);
    render(<PreferencesPage />);
    await userEvent.click(await screen.findByRole('switch', named(en.accountPreferences.personalization)));
    await waitFor(() => expect(screen.getByRole('switch', named(en.accountPreferences.personalization))).not.toBeChecked());
    expect(writes(calls)).toEqual([{ url: '/api/v1/users/me/personalization-settings', method: 'PATCH', body: { personalizationEnabled: false } }]);
    expect(state.personalization).toBe(false);
  });

  it('a failed write keeps the switch at the server value and says so', async () => {
    stub({ locales: ['en'], marketing: false, proactive: true, personalization: true, failWrites: true });
    render(<PreferencesPage />);
    const toggle = await screen.findByRole('switch', named(en.accountPreferences.personalization));
    await userEvent.click(toggle);
    expect(await screen.findByText(en.accountPreferences.saveFailed)).toBeInTheDocument();
    expect(screen.getByRole('switch', named(en.accountPreferences.personalization))).toBeChecked();
  });

  it('language: with one language it says so; with Urdu available it renders spec 042’s switcher, saving through /users/me/locale', async () => {
    stub({ locales: ['en'], marketing: false, proactive: true, personalization: true });
    const { unmount } = render(<PreferencesPage />);
    expect(await screen.findByText(en.accountPreferences.languageOnlyOne)).toBeInTheDocument();
    unmount();

    const calls = stub({ locales: ['en', 'ur'], marketing: false, proactive: true, personalization: true });
    render(<PreferencesPage />);
    const section = (await screen.findByRole('heading', { name: en.accountPreferences.languageHeading })).closest('section')!;
    const select = await within(section as HTMLElement).findByRole('combobox');
    await userEvent.selectOptions(select, 'ur');
    await waitFor(() => expect(writes(calls).some((c) => c.url === '/api/v1/users/me/locale' && c.body?.locale === 'ur')).toBe(true));
    expect(screen.queryByText(en.accountPreferences.languageOnlyOne)).not.toBeInTheDocument();
  });
});
