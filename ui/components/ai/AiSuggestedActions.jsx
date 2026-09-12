import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function AiSuggestedActions({ label = 'Suggested', actions = [], onSelect, style }) {
  return (
    <div style={{ display: 'grid', gap: 8, ...style }}>
      {label ? <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-semibold)', letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase', color: 'var(--text-subtle)' }}>{label}</span> : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {actions.map((a) => {
          const item = typeof a === 'string' ? { label: a } : a;
          return (
            <button key={item.label} type="button" onClick={() => onSelect && onSelect(item)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 34, padding: '0 12px',
                background: 'var(--ai-surface)', border: '1px solid var(--ai-border)',
                borderRadius: 'var(--radius-pill)', cursor: 'pointer',
                fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-medium)',
                color: 'var(--text-brand)', transition: 'background var(--duration-fast) var(--ease-standard)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--teal-100)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--ai-surface)'; }}>
              {item.icon ? <Icon name={item.icon} size="xs" /> : null}{item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
