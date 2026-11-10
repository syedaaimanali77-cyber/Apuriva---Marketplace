import React from 'react';

export function Tabs({ items = [], activeId, onSelect, variant = 'underline', style }) {
  const pill = variant === 'pill';
  return (
    <div role="tablist" style={{
      display: 'flex', gap: pill ? 6 : 'var(--space-5)', alignItems: 'center',
      borderBottom: pill ? 'none' : '1px solid var(--border-subtle)',
      padding: pill ? 4 : 0, background: pill ? 'var(--surface-sunken)' : 'transparent',
      borderRadius: pill ? 'var(--radius-md)' : 0, overflowX: 'auto', ...style,
    }}>
      {items.map((it) => {
        const on = it.id === activeId;
        return (
          <button key={it.id} role="tab" type="button" aria-selected={on} tabIndex={on ? 0 : -1}
            onClick={() => onSelect && onSelect(it.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
              minHeight: pill ? 32 : 40, padding: pill ? '0 12px' : '0 0 10px',
              border: 'none', cursor: 'pointer',
              background: pill ? (on ? 'var(--white)' : 'transparent') : 'transparent',
              borderRadius: pill ? 'var(--radius-sm)' : 0,
              boxShadow: pill && on ? 'var(--shadow-xs)' : 'none',
              borderBottom: pill ? 'none' : `2px solid ${on ? 'var(--teal-600)' : 'transparent'}`,
              marginBottom: pill ? 0 : -1,
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)',
              fontWeight: on ? 'var(--weight-semibold)' : 'var(--weight-medium)',
              color: on ? 'var(--text-heading)' : 'var(--text-muted)',
              transition: 'color var(--duration-fast) var(--ease-standard)',
            }}>
            {it.label}
            {it.count !== undefined ? <span data-numeric style={{
              minWidth: 20, height: 18, padding: '0 6px', display: 'inline-grid', placeItems: 'center',
              borderRadius: 'var(--radius-pill)', background: on ? 'var(--surface-brand-subtle)' : 'var(--gray-100)',
              color: on ? 'var(--text-brand)' : 'var(--text-muted)', fontSize: 'var(--text-2xs)', fontWeight: 700,
            }}>{it.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
