import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function StatBlock({ label, value, unit, delta, deltaTone = 'success', icon, hint, style }) {
  return (
    <div style={{
      display: 'grid', gap: 6, padding: 'var(--density-card-pad)',
      background: 'var(--surface-card)', border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-lg)', ...style,
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
        {icon ? <Icon name={icon} size="xs" /> : null}{label}
      </span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span data-numeric style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-3xl)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)', letterSpacing: 'var(--tracking-tight)', lineHeight: 1 }}>{value}</span>
        {unit ? <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{unit}</span> : null}
      </span>
      {delta !== undefined ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)', color: deltaTone === 'error' ? 'var(--status-error-fg)' : 'var(--status-success-fg)' }}>
          <Icon name="trending-up" size="xs" strokeWidth={2} />{delta}
        </span>
      ) : null}
      {hint ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>{hint}</span> : null}
    </div>
  );
}
