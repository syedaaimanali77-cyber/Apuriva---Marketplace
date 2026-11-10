import React from 'react';
import { Icon } from './Icon.jsx';

const SIZES = { sm: 32, md: 40, lg: 44 };

export function IconButton({ icon, label, variant = 'ghost', size = 'md', disabled = false, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const px = SIZES[size] || SIZES.md;
  const tone = {
    ghost: { background: hover && !disabled ? 'var(--action-ghost-bg-hover)' : 'transparent', color: 'var(--action-ghost-fg)', border: '1px solid transparent' },
    outline: { background: hover && !disabled ? 'var(--gray-100)' : 'var(--white)', color: 'var(--navy-800)', border: '1px solid var(--border-subtle)' },
    solid: { background: hover && !disabled ? 'var(--action-primary-bg-hover)' : 'var(--action-primary-bg)', color: 'var(--action-primary-fg)', border: '1px solid transparent' },
  }[variant];
  return (
    <button
      type="button" aria-label={label} title={label} disabled={disabled}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        width: px, height: px, display: 'inline-grid', placeItems: 'center', padding: 0,
        borderRadius: 'var(--radius-md)', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'background var(--duration-fast) var(--ease-standard)',
        ...tone, ...style,
      }}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 'sm' : 'md'} />
    </button>
  );
}
