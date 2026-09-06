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

describe('RootLayout', () => {
  it('renders the root HTML shell without throwing', () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <div>child content</div>
      </RootLayout>,
    );

    expect(markup).toContain('<html');
    expect(markup).toContain('child content');
  });
});
