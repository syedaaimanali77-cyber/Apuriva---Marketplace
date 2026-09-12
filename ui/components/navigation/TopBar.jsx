import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function TopBar({ start, children, end, sticky = true, tone = 'light', style }) {
  const dark = tone === 'dark';
  return (
    <header style={{
      position: sticky ? 'sticky' : 'static', top: 0, zIndex: 'var(--z-nav)',
      display: 'flex', alignItems: 'center', gap: 'var(--space-4)',
      height: 'var(--nav-top-h)', padding: '0 var(--space-5)',
      background: dark ? 'var(--surface-nav-inverse)' : 'var(--surface-nav)',
      borderBottom: `1px solid ${dark ? 'var(--border-inverse)' : 'var(--border-subtle)'}`,
      ...style,
    }}>
      {start}
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>{end}</div>
    </header>
  );
}
