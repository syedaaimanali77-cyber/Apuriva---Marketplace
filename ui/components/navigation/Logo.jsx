import React from 'react';

/** Apuriva wordmark. Uses the supplied logo artwork when `src` is given, otherwise renders the
 *  wordmark in the display face. The artwork is never redrawn or recoloured. */
export function Logo({ src, variant = 'full', size = 28, tagline = false, tone = 'dark', style }) {
  const color = tone === 'light' ? 'var(--white)' : 'var(--navy-900)';
  if (src) return <img src={src} alt="Apuriva" style={{ height: size * (variant === 'full' ? 1.9 : 1), width: 'auto', display: 'block', ...style }} />;
  return (
    <span style={{ display: 'inline-grid', gap: 2, ...style }}>
      <span style={{
        fontFamily: 'var(--font-display)', fontWeight: 'var(--weight-bold)', fontSize: size,
        letterSpacing: '0.04em', lineHeight: 1, color,
      }}>APURIVA</span>
      {tagline ? (
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: Math.max(10, size * 0.38), color: tone === 'light' ? 'var(--teal-300)' : 'var(--teal-700)' }}>
          Get the right help. Get it done.
        </span>
      ) : null}
    </span>
  );
}
