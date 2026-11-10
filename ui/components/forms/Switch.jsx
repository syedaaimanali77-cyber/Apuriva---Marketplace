import React from 'react';

export function Switch({ label, description, checked = false, disabled = false, onChange, id, style }) {
  return (
    <label htmlFor={id} style={{
      display: 'flex', alignItems: 'center', gap: 12, minHeight: 'var(--touch-target-min)',
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1, ...style,
    }}>
      <button
        id={id} type="button" role="switch" aria-checked={checked} disabled={disabled}
        onClick={() => onChange && onChange(!checked)}
        style={{
          width: 44, height: 26, flexShrink: 0, padding: 3, borderRadius: 'var(--radius-pill)',
          border: '1px solid transparent', cursor: 'inherit',
          background: checked ? 'var(--action-primary-bg)' : 'var(--gray-300)',
          transition: 'background var(--duration-normal) var(--ease-standard)',
          display: 'flex', justifyContent: checked ? 'flex-end' : 'flex-start',
        }}
      >
        <span style={{
          width: 20, height: 20, borderRadius: 'var(--radius-circle)', background: 'var(--white)',
          boxShadow: 'var(--shadow-sm)', transition: 'transform var(--duration-normal) var(--ease-out)',
        }} />
      </button>
      <span style={{ display: 'grid', gap: 2 }}>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', color: 'var(--text-heading)' }}>{label}</span>
        {description ? <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{description}</span> : null}
      </span>
    </label>
  );
}
