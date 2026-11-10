import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function RequestStatusTimeline({ steps = [], currentIndex = 0, orientation = 'vertical', style }) {
  const vertical = orientation === 'vertical';
  return (
    <ol aria-label="Request progress" style={{
      listStyle: 'none', margin: 0, padding: 0, display: vertical ? 'grid' : 'flex',
      gap: vertical ? 0 : 'var(--space-2)', alignItems: vertical ? undefined : 'flex-start', ...style,
    }}>
      {steps.map((s, i) => {
        const done = i < currentIndex, active = i === currentIndex;
        const color = done ? 'var(--teal-600)' : active ? 'var(--teal-600)' : 'var(--gray-300)';
        return (
          <li key={s.label || i} aria-current={active ? 'step' : undefined}
            style={{ display: vertical ? 'grid' : 'grid', gridTemplateColumns: vertical ? '24px 1fr' : undefined, gap: vertical ? 12 : 6, flex: vertical ? undefined : 1 }}>
            {vertical ? (
              <span style={{ display: 'grid', justifyItems: 'center', gap: 2 }}>
                <span style={{
                  width: 20, height: 20, borderRadius: 'var(--radius-circle)', display: 'grid', placeItems: 'center',
                  background: done ? 'var(--teal-600)' : active ? 'var(--white)' : 'var(--gray-100)',
                  border: `2px solid ${color}`, boxShadow: active ? '0 0 0 4px var(--teal-100)' : 'none',
                }}>
                  {done ? <Icon name="check" size={11} color="var(--white)" strokeWidth={3} /> : null}
                </span>
                {i < steps.length - 1 ? <span style={{ width: 2, flex: 1, minHeight: 22, background: done ? 'var(--teal-600)' : 'var(--gray-200)' }} /> : null}
              </span>
            ) : (
              <span style={{ height: 4, borderRadius: 'var(--radius-pill)', background: done || active ? 'var(--teal-600)' : 'var(--gray-200)' }} />
            )}
            <span style={{ display: 'grid', gap: 2, paddingBottom: vertical ? 'var(--space-4)' : 0 }}>
              <span style={{
                fontFamily: 'var(--font-sans)', fontSize: vertical ? 'var(--text-base)' : 'var(--text-xs)',
                fontWeight: active ? 'var(--weight-semibold)' : 'var(--weight-medium)',
                color: done || active ? 'var(--text-heading)' : 'var(--text-subtle)',
              }}>{s.label}</span>
              {s.detail && vertical ? <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{s.detail}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
