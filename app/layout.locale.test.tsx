// @vitest-environment jsdom
/**
 * Spec 042 §3.4 (X-1, AC-1, AC-8, R-5) — the SERVER resolves `lang`/`dir`, so the first paint is already
 * right-to-left for Urdu. `getRequestLocale()` runs for real here; only its request inputs (`next/headers`)
 * and the `urdu-locale` flag read are stubbed.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocale } from './_components/LocaleProvider';
import { ur } from '@/lib/i18n/dictionaries/ur';

const request = vi.hoisted(() => ({ cookies: {} as Record<string, string>, acceptLanguage: null as string | null, urduLocale: false }));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name in request.cookies ? { name, value: request.cookies[name] } : undefined) }),
  headers: async () => ({ get: (name: string) => (name.toLowerCase() === 'accept-language' ? request.acceptLanguage : null) }),
}));
vi.mock('@/lib/feature-flags', () => ({
  isFeatureEnabled: vi.fn(async (key: string) => key === 'urdu-locale' && request.urduLocale),
}));
// AppHeader/NavShell/AuthGateResumer need an App Router context this bare render doesn't provide.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

const { default: RootLayout } = await import('./layout');
const { default: GlobalError } = await import('./global-error');

function Probe() {
  const { locale, direction, t } = useLocale();
  return <p data-testid="probe">{`${locale}|${direction}|${t('common.tryAgain')}`}</p>;
}

async function renderLayout(): Promise<string> {
  const element = await RootLayout({ children: <Probe /> });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  request.cookies = {};
  request.acceptLanguage = null;
  request.urduLocale = false;
});

describe('root layout lang/dir (spec 042 §3.4, AC-1)', () => {
  it('flag on + ur cookie: <html lang="ur" dir="rtl"> in the server HTML, and the provider carries the ur dictionary', async () => {
    request.urduLocale = true;
    request.cookies = { apuriva_locale: 'ur' };
    const markup = await renderLayout();
    expect(markup).toMatch(/^<html lang="ur" dir="rtl"/);
    expect(markup).toContain(`ur|rtl|${ur.common.tryAgain}`);
  });

  it('flag on + Accept-Language ur, no cookie: resolves ur', async () => {
    request.urduLocale = true;
    request.acceptLanguage = 'ur-PK,ur;q=0.9,en;q=0.8';
    expect(await renderLayout()).toMatch(/^<html lang="ur" dir="rtl"/);
  });

  it('AC-8: flag off, a ur cookie and Accept-Language are treated as unset → <html lang="en" dir="ltr">', async () => {
    request.cookies = { apuriva_locale: 'ur' };
    request.acceptLanguage = 'ur';
    const markup = await renderLayout();
    expect(markup).toMatch(/^<html lang="en" dir="ltr"/);
    expect(markup).toContain('en|ltr|Try again');
  });

  it('an unsupported or malformed cookie falls through to en', async () => {
    request.urduLocale = true;
    request.cookies = { apuriva_locale: 'pt-BR' };
    expect(await renderLayout()).toMatch(/^<html lang="en" dir="ltr"/);
    request.cookies = { apuriva_locale: '<script>' };
    expect(await renderLayout()).toMatch(/^<html lang="en" dir="ltr"/);
  });
});

describe('global-error lang/dir from the cookie (spec 042 §3.4, R-5)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    document.cookie = 'apuriva_locale=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  });

  async function mountGlobalError(): Promise<() => void> {
    const root = createRoot(document);
    await act(async () => {
      root.render(<GlobalError error={new Error('boom')} reset={() => undefined} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return () => act(() => root.unmount());
  }

  it('renders en/ltr with no cookie', async () => {
    const unmount = await mountGlobalError();
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
  });

  it('renders ur/rtl for a ur cookie once the client-readable flag confirms urdu-locale is on', async () => {
    document.cookie = 'apuriva_locale=ur; path=/';
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { flags: { 'urdu-locale': true } } }) });
    const unmount = await mountGlobalError();
    expect(document.documentElement.getAttribute('lang')).toBe('ur');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.body.textContent).toContain(ur.common.tryAgain);
    unmount();
  });

  it('AC-8: stays en/ltr for a ur cookie while the flag is off', async () => {
    document.cookie = 'apuriva_locale=ur; path=/';
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: { flags: { 'urdu-locale': false } } }) });
    const unmount = await mountGlobalError();
    expect(document.documentElement.getAttribute('lang')).toBe('en');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    unmount();
  });
});
