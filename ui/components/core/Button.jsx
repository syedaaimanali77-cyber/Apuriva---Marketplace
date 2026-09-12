import React from 'react';
import { Icon } from './Icon.jsx';

// Borders are longhands (never the `border` shorthand) because the disabled state overrides
// `borderColor` alone — mixing the two makes React drop the border when a button re-enables.
const BORDER = { borderWidth: 1, borderStyle: 'solid' };
const VARIANTS = {
  primary: { background: 'var(--action-primary-bg)', color: 'var(--action-primary-fg)', ...BORDER, borderColor: 'var(--action-primary-bg)' },
  secondary: { background: 'var(--action-secondary-bg)', color: 'var(--action-secondary-fg)', ...BORDER, borderColor: 'var(--action-secondary-border)' },
  ghost: { background: 'transparent', color: 'var(--action-ghost-fg)', ...BORDER, borderColor: 'transparent' },
  accent: { background: 'var(--action-accent-bg)', color: 'var(--action-accent-fg)', ...BORDER, borderColor: 'var(--action-accent-bg)' },
  danger: { background: 'var(--action-danger-bg)', color: 'var(--action-danger-fg)', ...BORDER, borderColor: 'var(--action-danger-bg)' },
  inverse: { background: 'var(--white)', color: 'var(--navy-900)', ...BORDER, borderColor: 'var(--white)' },
};
const HOVER = {
  primary: 'var(--action-primary-bg-hover)', secondary: 'var(--action-secondary-bg-hover)',
  ghost: 'var(--action-ghost-bg-hover)', accent: 'var(--action-accent-bg-hover)',
  danger: 'var(--action-danger-bg-hover)', inverse: 'var(--gray-100)',
};
const SIZES = {
  sm: { height: 32, padding: '0 12px', fontSize: 'var(--text-sm)', gap: 6, radius: 'var(--radius-sm)' },
  md: { height: 40, padding: '0 16px', fontSize: 'var(--text-base)', gap: 8, radius: 'var(--radius-md)' },
  lg: { height: 48, padding: '0 22px', fontSize: 'var(--text-md)', gap: 8, radius: 'var(--radius-md)' },
};

export function Button({
  variant = 'primary', size = 'md', iconLeft, iconRight, loading = false, disabled = false,
  fullWidth = false, type = 'button', children, style, onClick, ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const [active, setActive] = React.useState(false);
  const s = SIZES[size] || SIZES.md;
  const v = VARIANTS[variant] || VARIANTS.primary;
  const off = disabled || loading;
  return (
    <button
      type={type} disabled={off} onClick={off ? undefined : onClick}
      aria-busy={loading || undefined}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)} onMouseUp={() => setActive(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: s.gap,
        minHeight: s.height, height: s.height, padding: s.padding, width: fullWidth ? '100%' : undefined,
        fontFamily: 'var(--font-sans)', fontSize: s.fontSize, fontWeight: 'var(--weight-semibold)',
        letterSpacing: 'var(--tracking-snug)', lineHeight: 1, whiteSpace: 'nowrap',
        borderRadius: s.radius, cursor: off ? 'not-allowed' : 'pointer',
        transition: 'background var(--duration-fast) var(--ease-standard), transform var(--duration-instant) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)',
        transform: active && !off ? 'scale(.985)' : 'none',
        ...v,
        ...(hover && !off ? { background: HOVER[variant] } : null),
        ...(off ? { background: variant === 'ghost' ? 'transparent' : 'var(--action-disabled-bg)', color: 'var(--action-disabled-fg)', borderColor: variant === 'ghost' ? 'transparent' : 'var(--action-disabled-bg)' } : null),
        ...style,
      }}
      {...rest}
    >
      {loading ? <Icon name="loader-circle" size={size === 'sm' ? 'xs' : 'sm'} style={{ animation: 'apr-spin var(--duration-slower) linear infinite' }} /> : iconLeft ? <Icon name={iconLeft} size={size === 'sm' ? 'xs' : 'sm'} /> : null}
      <span>{children}</span>
      {iconRight && !loading ? <Icon name={iconRight} size={size === 'sm' ? 'xs' : 'sm'} /> : null}
      <style>{'@keyframes apr-spin{to{transform:rotate(360deg)}}'}</style>
    </button>
  );
}
