import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Select({ options = [], size = 'md', invalid = false, disabled = false, placeholder, style, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  const h = size === 'sm' ? 34 : size === 'lg' ? 48 : 40;
  const border = invalid ? 'var(--field-border-error)' : focus ? 'var(--field-border-focus)' : 'var(--field-border)';
  return (
    <div style={{
      position: 'relative', display: 'flex', alignItems: 'center', height: h, width: '100%',
      background: disabled ? 'var(--field-bg-disabled)' : 'var(--field-bg)',
      border: `1px solid ${border}`, borderRadius: 'var(--radius-md)',
      boxShadow: focus ? 'var(--ring-focus)' : 'none',
      transition: 'border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)',
      ...style,
    }}>
      <select
        disabled={disabled} aria-invalid={invalid || undefined}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        {...rest}
        style={{
          appearance: 'none', width: '100%', height: '100%', padding: '0 36px 0 12px',
          border: 'none', outline: 'none', background: 'transparent', cursor: disabled ? 'not-allowed' : 'pointer',
          fontFamily: 'var(--font-sans)', fontSize: size === 'sm' ? 'var(--text-sm)' : 'var(--text-base)',
          color: 'var(--text-heading)',
        }}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((o) => {
          const opt = typeof o === 'string' ? { value: o, label: o } : o;
          return <option key={opt.value} value={opt.value} disabled={opt.disabled}>{opt.label}</option>;
        })}
      </select>
      <Icon name="chevron-down" size="sm" color="var(--text-muted)" style={{ position: 'absolute', insetInlineEnd: 12, pointerEvents: 'none' }} />
    </div>
  );
}
