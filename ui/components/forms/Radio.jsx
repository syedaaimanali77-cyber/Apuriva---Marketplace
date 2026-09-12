import React from 'react';

export function Radio({ label, description, checked, disabled = false, style, ...rest }) {
  return (
    <label style={{
      display: 'flex', alignItems: description ? 'flex-start' : 'center', gap: 10,
      minHeight: 'var(--touch-target-min)', cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.55 : 1, ...style,
    }}>
      <span style={{ position: 'relative', display: 'grid', placeItems: 'center', width: 20, height: 20, marginTop: description ? 2 : 0, flexShrink: 0 }}>
        <input type="radio" checked={checked} disabled={disabled} {...rest}
          style={{ position: 'absolute', inset: 0, margin: 0, opacity: 0, cursor: 'inherit' }} />
        <span aria-hidden="true" style={{
          width: 20, height: 20, borderRadius: 'var(--radius-circle)', display: 'grid', placeItems: 'center',
          background: 'var(--field-bg)',
          border: `1px solid ${checked ? 'var(--action-primary-bg)' : 'var(--field-border)'}`,
          transition: 'border-color var(--duration-fast) var(--ease-standard)',
        }}>
          {checked ? <span style={{ width: 10, height: 10, borderRadius: 'var(--radius-circle)', background: 'var(--action-primary-bg)' }} /> : null}
        </span>
      </span>
      <span style={{ display: 'grid', gap: 2 }}>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', color: 'var(--text-heading)' }}>{label}</span>
        {description ? <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{description}</span> : null}
      </span>
    </label>
  );
}

export function RadioGroup({ legend, children, style }) {
  return (
    <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'grid', gap: 4, ...style }}>
      {legend ? <legend style={{ padding: 0, marginBottom: 4, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--field-label)' }}>{legend}</legend> : null}
      {children}
    </fieldset>
  );
}
