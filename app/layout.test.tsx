import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import RootLayout from './layout';

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
