import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function SideNav({ items = [], activeId, onSelect, header, footer, tone = 'light', collapsed = false, style }) {
  const dark = tone === 'dark';
  return (
    <nav aria-label="Primary" style={{
      width: collapsed ? 'var(--nav-side-w-collapsed)' : 'var(--nav-side-w)', flexShrink: 0,
      display: 'flex', flexDirection: 'column', gap: 4, padding: 'var(--space-4) var(--space-3)',
      background: dark ? 'var(--surface-nav-inverse)' : 'var(--surface-nav)',
      borderInlineEnd: `1px solid ${dark ? 'var(--border-inverse)' : 'var(--border-subtle)'}`,
      ...style,
    }}>
      {header ? <div style={{ padding: '4px 8px 14px' }}>{header}</div> : null}
      {items.map((it) => it.section ? (
        <div key={it.section} style={{
          padding: '14px 10px 4px', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-2xs)',
          fontWeight: 'var(--weight-semibold)', letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase',
          color: dark ? 'var(--navy-600)' : 'var(--text-subtle)',
        }}>{collapsed ? '' : it.section}</div>
      ) : (
        <button key={it.id} type="button" onClick={() => onSelect && onSelect(it.id)}
          aria-current={it.id === activeId ? 'page' : undefined} title={collapsed ? it.label : undefined}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, minHeight: 40, padding: collapsed ? 0 : '0 10px',
            justifyContent: collapsed ? 'center' : 'flex-start',
            border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', textAlign: 'start',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)',
            fontWeight: it.id === activeId ? 'var(--weight-semibold)' : 'var(--weight-medium)',
            background: it.id === activeId ? (dark ? 'var(--navy-800)' : 'var(--surface-brand-subtle)') : 'transparent',
            color: it.id === activeId ? (dark ? 'var(--teal-300)' : 'var(--text-brand)') : (dark ? 'var(--navy-100)' : 'var(--text-body)'),
            transition: 'background var(--duration-fast) var(--ease-standard)',
          }}>
          <Icon name={it.icon} size="sm" strokeWidth={it.id === activeId ? 2.1 : 1.75} />
          {collapsed ? null : <span style={{ flex: 1 }}>{it.label}</span>}
          {!collapsed && it.badge ? <span data-numeric style={{
            minWidth: 20, height: 20, padding: '0 6px', display: 'grid', placeItems: 'center',
            borderRadius: 'var(--radius-pill)', background: dark ? 'var(--navy-700)' : 'var(--gray-100)',
            color: dark ? 'var(--white)' : 'var(--text-muted)', fontSize: 'var(--text-2xs)', fontWeight: 700,
          }}>{it.badge}</span> : null}
        </button>
      ))}
      {footer ? <div style={{ marginTop: 'auto', paddingTop: 12 }}>{footer}</div> : null}
    </nav>
  );
}
