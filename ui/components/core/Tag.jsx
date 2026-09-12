import React from 'react';
import { Icon } from './Icon.jsx';

export function Tag({ children, icon, onRemove, selected = false, onClick, style, ...rest }) {
  const interactive = Boolean(onClick);
  const Comp = interactive ? 'button' : 'span';
  return (
    <Comp
      type={interactive ? 'button' : undefined} onClick={onClick}
      aria-pressed={interactive ? selected : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px',
        borderRadius: 'var(--radius-pill)', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)',
        fontWeight: 'var(--weight-medium)', cursor: interactive ? 'pointer' : 'default',
        background: selected ? 'var(--surface-brand-subtle)' : 'var(--white)',
        color: selected ? 'var(--text-brand)' : 'var(--text-body)',
        border: `1px solid ${selected ? 'var(--border-brand)' : 'var(--border-subtle)'}`,
        transition: 'background var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)',
        ...style,
      }}
      {...rest}
    >
      {icon ? <Icon name={icon} size="xs" /> : null}
      {children}
      {onRemove ? (
        <span role="button" tabIndex={0} aria-label="Remove" onClick={(e) => { e.stopPropagation(); onRemove(); }}
          style={{ display: 'inline-grid', placeItems: 'center', marginInlineEnd: -4 }}>
          <Icon name="x" size={13} strokeWidth={2.2} />
        </span>
      ) : null}
    </Comp>
  );
}
