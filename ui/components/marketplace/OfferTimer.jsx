import React from 'react';
import { Icon } from '../core/Icon.jsx';

/** Cosmetic countdown for the 2-minute offer window. The server decides expiry (master spec §32). */
export function OfferTimer({ secondsRemaining = 0, totalSeconds = 120, expired = false, size = 'md', style }) {
  const s = Math.max(0, secondsRemaining);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const pct = Math.max(0, Math.min(100, (s / totalSeconds) * 100));
  const urgent = !expired && s <= 30;
  const fg = expired ? 'var(--text-muted)' : urgent ? 'var(--timer-urgent)' : 'var(--teal-700)';
  const bg = expired ? 'var(--gray-100)' : urgent ? 'var(--status-error-bg)' : 'var(--surface-brand-subtle)';
  return (
    <div role="timer" aria-live={urgent ? 'assertive' : 'off'} style={{ display: 'grid', gap: 5, ...style }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, justifySelf: 'start',
        padding: size === 'sm' ? '2px 8px' : '4px 10px', borderRadius: 'var(--radius-pill)',
        background: bg, color: fg, fontFamily: 'var(--font-sans)',
        fontSize: size === 'sm' ? 'var(--text-xs)' : 'var(--text-sm)', fontWeight: 'var(--weight-semibold)',
      }}>
        <Icon name={expired ? 'circle-x' : 'clock'} size={size === 'sm' ? 12 : 14} strokeWidth={2} />
        {expired ? 'Offer expired' : <span data-numeric>{mm}:{ss} left</span>}
      </span>
      {!expired ? (
        <span aria-hidden="true" style={{ height: 4, borderRadius: 'var(--radius-pill)', background: 'var(--gray-200)', overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: pct + '%', background: fg, transition: 'width 1s linear' }} />
        </span>
      ) : null}
    </div>
  );
}
