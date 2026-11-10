import React from 'react';
import { Icon } from '../core/Icon.jsx';

// The native <input> is the visible box and carries the focus ring itself (spec 043 D-7 checks the focused element,
// and an opacity-0 input showed keyboard users no focus at all); the tick is drawn over it.
export function Checkbox({ label, description, checked, indeterminate = false, disabled = false, onChange, onFocus, onBlur, style, ...rest }) {
  const ref = React.useRef(null);
  const [focus, setFocus] = React.useState(false);
  const on = checked || indeterminate;
  React.useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return (
    <label style={{
      display: 'flex', alignItems: description ? 'flex-start' : 'center', gap: 10,
      minHeight: 'var(--touch-target-min)', cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.55 : 1, ...style,
    }}>
      <span style={{ position: 'relative', display: 'grid', placeItems: 'center', width: 20, height: 20, marginTop: description ? 2 : 0, flexShrink: 0 }}>
        <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} {...rest}
          onFocus={(e) => { setFocus(true); onFocus && onFocus(e); }}
          onBlur={(e) => { setFocus(false); onBlur && onBlur(e); }}
          style={{
            appearance: 'none', WebkitAppearance: 'none', margin: 0, width: 20, height: 20, boxSizing: 'border-box',
            borderRadius: 'var(--radius-xs)', cursor: 'inherit',
            background: on ? 'var(--action-primary-bg)' : 'var(--field-bg)',
            border: `1px solid ${on ? 'var(--action-primary-bg)' : 'var(--field-border)'}`,
            boxShadow: focus ? 'var(--ring-focus)' : 'none',
            transition: 'background var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)',
          }} />
        <span aria-hidden="true" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
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
