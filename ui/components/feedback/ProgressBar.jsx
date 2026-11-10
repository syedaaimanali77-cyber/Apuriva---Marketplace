import React from 'react';

export function ProgressBar({ value, max = 100, label, tone = 'brand', showValue = false, indeterminate = false, style }) {
  const pct = indeterminate ? 40 : Math.min(100, Math.round(((value || 0) / max) * 100));
  const fill = { brand: 'var(--teal-600)', accent: 'var(--amber-500)', success: 'var(--success-600)', error: 'var(--error-600)' }[tone];
  return (
    <div style={{ display: 'grid', gap: 6, ...style }}>
      {(label || showValue) ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          <span>{label}</span>{showValue ? <span data-numeric>{pct}%</span> : null}
        </div>
      ) : null}
      <div role="progressbar" aria-valuenow={indeterminate ? undefined : pct} aria-valuemin={0} aria-valuemax={100} aria-label={typeof label === 'string' ? label : 'Progress'}
        style={{ height: 6, borderRadius: 'var(--radius-pill)', background: 'var(--gray-200)', overflow: 'hidden' }}>
        <div style={{
          height: '100%', width: pct + '%', background: fill, borderRadius: 'var(--radius-pill)',
          transition: 'width var(--duration-normal) var(--ease-standard)',
          animation: indeterminate ? 'apr-indet 1.2s var(--ease-standard) infinite' : undefined,
        }} />
      </div>
      <style>{'@keyframes apr-indet{0%{margin-inline-start:-40%}100%{margin-inline-start:100%}}'}</style>
    </div>
  );
}
