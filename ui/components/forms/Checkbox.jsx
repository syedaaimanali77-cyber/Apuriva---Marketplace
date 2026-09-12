import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Checkbox({ label, description, checked, indeterminate = false, disabled = false, onChange, style, ...rest }) {
  const ref = React.useRef(null);
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return (
    <label style={{
      display: 'flex', alignItems: description ? 'flex-start' : 'center', gap: 10,
      minHeight: 'var(--touch-target-min)', cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.55 : 1, ...style,
    }}>
      <span style={{ position: 'relative', display: 'grid', placeItems: 'center', width: 20, height: 20, marginTop: description ? 2 : 0, flexShrink: 0 }}>
        <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} {...rest}
          style={{ position: 'absolute', inset: 0, margin: 0, opacity: 0, cursor: 'inherit' }} />
        <span aria-hidden="true" style={{
          width: 20, height: 20, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-xs)',
          background: checked || indeterminate ? 'var(--action-primary-bg)' : 'var(--field-bg)',
          border: `1px solid ${checked || indeterminate ? 'var(--action-primary-bg)' : 'var(--field-border)'}`,
          transition: 'background var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)',
        }}>
          {indeterminate ? <span style={{ width: 10, height: 2, background: 'var(--white)', borderRadius: 1 }} />
            : checked ? <Icon name="check" size={13} color="var(--white)" strokeWidth={3} /> : null}
        </span>
      </span>
      <span style={{ display: 'grid', gap: 2 }}>
        <span style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', color: 'var(--text-heading)' }}>{label}</span>
        {description ? <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{description}</span> : null}
      </span>
    </label>
  );
}
