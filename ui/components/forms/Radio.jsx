import React from 'react';

// The native <input> is the visible circle and carries the focus ring itself (spec 043 D-7 checks the focused
// element, and an opacity-0 input showed keyboard users no focus at all); the dot is drawn over it.
export function Radio({ label, description, checked, disabled = false, onFocus, onBlur, style, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <label style={{
      display: 'flex', alignItems: description ? 'flex-start' : 'center', gap: 10,
      minHeight: 'var(--touch-target-min)', cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.55 : 1, ...style,
    }}>
      <span style={{ position: 'relative', display: 'grid', placeItems: 'center', width: 20, height: 20, marginTop: description ? 2 : 0, flexShrink: 0 }}>
        <input type="radio" checked={checked} disabled={disabled} {...rest}
          onFocus={(e) => { setFocus(true); onFocus && onFocus(e); }}
          onBlur={(e) => { setFocus(false); onBlur && onBlur(e); }}
          style={{
            appearance: 'none', WebkitAppearance: 'none', margin: 0, width: 20, height: 20, boxSizing: 'border-box',
            borderRadius: 'var(--radius-circle)', cursor: 'inherit', background: 'var(--field-bg)',
            border: `1px solid ${checked ? 'var(--action-primary-bg)' : 'var(--field-border)'}`,
            boxShadow: focus ? 'var(--ring-focus)' : 'none',
            transition: 'border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)',
          }} />
        <span aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
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
