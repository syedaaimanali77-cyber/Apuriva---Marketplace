// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/dictionaries/en';
import { DemoModeBanner } from './DemoModeBanner';

const demo = vi.hoisted(() => ({ shouldShowDemoBanner: vi.fn() }));
vi.mock('@/lib/demo/guards', () => ({ shouldShowDemoBanner: demo.shouldShowDemoBanner }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/lib/i18n/server', () => ({ getRequestLocale: async () => ({ locale: 'en', direction: 'ltr' }) }));

/** Spec 045 §5 / AC-3 — master §111's "clear Demo Mode label". */
describe('DemoModeBanner', () => {
  afterEach(() => demo.shouldShowDemoBanner.mockReset());

  it('is a status message with the Demo badge and the sample-data notice, and no dismiss control', () => {
    render(<DemoModeBanner />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(en.demo.banner.label);
    expect(status).toHaveTextContent(en.demo.banner.text);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('the root layout renders it on every page when the server-side condition holds (flag on, not production)', async () => {
    demo.shouldShowDemoBanner.mockResolvedValue(true);
    const { default: RootLayout } = await import('@/app/layout');
    const markup = renderToStaticMarkup(await RootLayout({ children: <div>page</div> }));
    expect(markup).toContain('data-testid="demo-mode-banner"');
    expect(markup).toContain(en.demo.banner.text);
  });

  it('the root layout renders no banner otherwise', async () => {
    demo.shouldShowDemoBanner.mockResolvedValue(false);
    const { default: RootLayout } = await import('@/app/layout');
    const markup = renderToStaticMarkup(await RootLayout({ children: <div>page</div> }));
    expect(markup).not.toContain('demo-mode-banner');
  });
});
