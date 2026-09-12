import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function BottomTabBar({ items = [], activeId, onSelect, style }) {
  return (
    <nav aria-label="Primary" style={{
      position: 'sticky', bottom: 0, display: 'grid', gridAutoFlow: 'column', gridAutoColumns: '1fr',
      height: 'var(--nav-bottom-h)', background: 'var(--surface-nav)',
      borderTop: '1px solid var(--border-subtle)', zIndex: 'var(--z-nav)', ...style,
    }}>
      {items.map((it) => {
        const on = it.id === activeId;
        return (
          <button key={it.id} type="button" onClick={() => onSelect && onSelect(it.id)}
            aria-current={on ? 'page' : undefined}
            style={{
              display: 'grid', justifyItems: 'center', alignContent: 'center', gap: 3,
              minHeight: 'var(--touch-target-min)', border: 'none', background: 'transparent', cursor: 'pointer',
              color: on ? 'var(--teal-700)' : 'var(--text-muted)', position: 'relative',
            }}>
            <span style={{ position: 'relative' }}>
              <Icon name={it.icon} size="md" strokeWidth={on ? 2.2 : 1.75} />
              {it.badge ? <span aria-label={it.badge + ' new'} style={{
                position: 'absolute', top: -3, insetInlineEnd: -7, minWidth: 16, height: 16, padding: '0 4px',
                display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-pill)',
                background: 'var(--amber-600)', color: 'var(--white)', fontSize: 10, fontWeight: 700,
              }} data-numeric>{it.badge}</span> : null}
            </span>
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-2xs)', fontWeight: on ? 'var(--weight-semibold)' : 'var(--weight-medium)' }}>{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
