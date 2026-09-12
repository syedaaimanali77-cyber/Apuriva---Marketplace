import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function AiActivityLog({ groups = [], style }) {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)', ...style }}>
      {groups.map((g) => (
        <section key={g.label} style={{ display: 'grid', gap: 'var(--space-2)' }}>
          <h4 style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-semibold)', letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase', color: 'var(--text-subtle)' }}>{g.label}</h4>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 2 }}>
            {g.entries.map((e, i) => {
              const failed = e.status === 'failed';
              return (
                <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0' }}>
                  <Icon name={failed ? 'circle-x' : 'circle-check-big'} size="sm" strokeWidth={2}
                    color={failed ? 'var(--status-error-fg)' : 'var(--success-600)'} style={{ marginTop: 2 }} />
                  <span style={{ flex: 1, display: 'grid', gap: 2 }}>
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', color: 'var(--text-body)' }}>{e.label}</span>
                    {e.detail ? <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{e.detail}</span> : null}
                    {e.confirmed ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-xs)', color: 'var(--text-brand)' }}><Icon name="shield-check" size={12} />Confirmed by you</span> : null}
                  </span>
                  {e.time ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-subtle)', whiteSpace: 'nowrap' }}>{e.time}</span> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
