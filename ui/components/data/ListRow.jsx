import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function ListRow({ icon, avatar, title, subtitle, meta, action, onClick, chevron, selected = false, style }) {
  const clickable = Boolean(onClick);
  const showChevron = chevron === undefined ? clickable : chevron;
  const Comp = clickable ? 'button' : 'div';
  return (
    <Comp type={clickable ? 'button' : undefined} onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)', width: '100%',
        minHeight: 'var(--touch-target-min)',
        padding: 'var(--density-row-y) var(--density-row-x)', textAlign: 'start',
        background: selected ? 'var(--surface-brand-subtle)' : 'transparent',
        border: 'none', borderBottom: '1px solid var(--border-subtle)',
        cursor: clickable ? 'pointer' : 'default', fontFamily: 'var(--font-sans)',
        transition: 'background var(--duration-fast) var(--ease-standard)', ...style,
      }}
      onMouseEnter={(e) => { if (clickable && !selected) e.currentTarget.style.background = 'var(--gray-50)'; }}
      onMouseLeave={(e) => { if (clickable && !selected) e.currentTarget.style.background = 'transparent'; }}>
      {avatar}
      {icon && !avatar ? <span style={{ width: 36, height: 36, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-md)', background: 'var(--surface-sunken)', flexShrink: 0 }}>
        <Icon name={icon} size="sm" color="var(--navy-800)" />
      </span> : null}
      <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2 }}>
        <span style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {subtitle ? <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</span> : null}
      </span>
      {meta ? <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{meta}</span> : null}
      {action}
      {showChevron ? <Icon name="chevron-right" size="sm" color="var(--text-subtle)" style={{ transform: 'var(--rtl-flip, none)' }} /> : null}
    </Comp>
  );
}
