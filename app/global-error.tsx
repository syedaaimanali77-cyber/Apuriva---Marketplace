'use client';

import { ErrorState } from '@/components/ErrorState';
import { brandFontVariables } from './fonts';
import './styles/apuriva-tokens.css';
import './globals.css';

/**
 * Root-layout error fallback. `global-error` replaces the root layout and doesn't inherit its
 * global styles or fonts, so it loads the DS tokens, base styles and brand fonts itself before
 * rendering the DS `ErrorState`.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className={brandFontVariables}>
      <body>
        <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 'var(--space-6)' }}>
          <ErrorState onRetry={() => reset()} />
        </main>
      </body>
    </html>
  );
}
