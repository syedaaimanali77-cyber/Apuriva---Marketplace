import React from 'react';
import { Icon } from './Icon.jsx';

const TONES = {
  neutral: ['var(--status-neutral-fg)', 'var(--status-neutral-bg)'],
  brand: ['var(--status-brand-fg)', 'var(--status-brand-bg)'],
  accent: ['var(--status-accent-fg)', 'var(--status-accent-bg)'],
  success: ['var(--status-success-fg)', 'var(--status-success-bg)'],
  warning: ['var(--status-warning-fg)', 'var(--status-warning-bg)'],
  error: ['var(--status-error-fg)', 'var(--status-error-bg)'],
  info: ['var(--status-info-fg)', 'var(--status-info-bg)'],
};
const DEFAULT_ICON = { success: 'circle-check-big', warning: 'triangle-alert', error: 'circle-x', info: 'info' };

export function Badge({ tone = 'neutral', icon, size = 'md', solid = false, children, style, ...rest }) {
  const [fg, bg] = TONES[tone] || TONES.neutral;
  const glyph = icon === null ? null : icon || DEFAULT_ICON[tone];
  const sm = size === 'sm';
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: sm ? 4 : 5,
        padding: sm ? '2px 8px' : '3px 10px', height: sm ? 20 : 24,
        borderRadius: 'var(--radius-pill)', fontFamily: 'var(--font-sans)',
        fontSize: sm ? 'var(--text-2xs)' : 'var(--text-xs)', fontWeight: 'var(--weight-semibold)',
        letterSpacing: 'var(--tracking-wide)', textTransform: 'none', whiteSpace: 'nowrap',
        color: solid ? 'var(--white)' : fg, background: solid ? fg : bg,
        ...style,
      }}
      {...rest}
    >
      {glyph ? <Icon name={glyph} size={sm ? 12 : 13} strokeWidth={2} /> : null}
      {children}
    </span>
  );
}
