import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import RootLayout from './layout';

// Spec 007's AuthGateResumer (mounted here) uses next/navigation's useRouter/usePathname, which
// require a real Next.js App Router context that this bare renderToStaticMarkup call doesn't
// provide — mocked the same way app/(auth)/login/page.test.tsx already does.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));

// Spec 042 §3.4 (X-1): the layout is an async server component that resolves `lang`/`dir` from the
// request. There is no request scope here, so the resolution is stubbed; its behaviour is covered by
// app/layout.locale.test.tsx.
vi.mock('@/lib/i18n/server', () => ({
  getRequestLocale: async () => ({ locale: 'en', direction: 'ltr' }),
}));

describe('RootLayout', () => {
  it('renders the root HTML shell without throwing', async () => {
    const markup = renderToStaticMarkup(
      await RootLayout({
        children: <div>child content</div>,
      }),
    );

    expect(markup).toContain('<html');
    expect(markup).toContain('child content');
  });
});
