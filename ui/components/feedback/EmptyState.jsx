import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function EmptyState({ icon = 'compass', title, description, action, secondaryAction, suggestions, compact = false, style }) {
  return (
    <div style={{
      display: 'grid', justifyItems: 'center', textAlign: 'center', gap: 10,
      padding: compact ? 'var(--space-6)' : 'var(--space-12) var(--space-6)', ...style,
    }}>
      <span style={{ width: 52, height: 52, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-circle)', background: 'var(--surface-brand-subtle)' }}>
        <Icon name={icon} size="lg" color="var(--teal-600)" />
      </span>
      <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' }}>{title}</h3>
      {description ? <p style={{ margin: 0, maxWidth: 420, fontSize: 'var(--text-base)', color: 'var(--text-muted)', lineHeight: 'var(--leading-normal)' }}>{description}</p> : null}
      {suggestions && suggestions.length ? (
        <ul style={{ margin: '4px 0 0', padding: 0, listStyle: 'none', display: 'grid', gap: 6, textAlign: 'start' }}>
          {suggestions.map((s, i) => (
            <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--text-base)', color: 'var(--text-body)' }}>
              <Icon name="arrow-right" size="xs" color="var(--teal-600)" />{s}
            </li>
          ))}
        </ul>
      ) : null}
      {action || secondaryAction ? <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>{action}{secondaryAction}</div> : null}
    </div>
  );
}
