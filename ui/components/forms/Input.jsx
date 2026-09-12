import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Input({
  size = 'md', iconLeft, iconRight, prefix, invalid = false, disabled = false,
  fullWidth = true, style, ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const h = size === 'sm' ? 34 : size === 'lg' ? 48 : 40;
  const border = invalid ? 'var(--field-border-error)' : focus ? 'var(--field-border-focus)' : 'var(--field-border)';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, height: h, width: fullWidth ? '100%' : undefined,
      padding: '0 12px', background: disabled ? 'var(--field-bg-disabled)' : 'var(--field-bg)',
      border: `1px solid ${border}`, borderRadius: 'var(--radius-md)',
      boxShadow: focus ? (invalid ? 'var(--ring-error)' : 'var(--ring-focus)') : 'none',
      transition: 'border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)',
      ...style,
    }}>
      {iconLeft ? <Icon name={iconLeft} size="sm" color="var(--text-subtle)" /> : null}
      {prefix ? <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{prefix}</span> : null}
      <input
        disabled={disabled} aria-invalid={invalid || undefined}
        onFocus={(e) => { setFocus(true); rest.onFocus && rest.onFocus(e); }}
        onBlur={(e) => { setFocus(false); rest.onBlur && rest.onBlur(e); }}
        {...rest}
        style={{
          flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
          fontFamily: 'var(--font-sans)', fontSize: size === 'sm' ? 'var(--text-sm)' : 'var(--text-base)',
          color: 'var(--text-heading)', height: '100%',
        }}
      />
      {iconRight ? <Icon name={iconRight} size="sm" color="var(--text-subtle)" /> : null}
    </div>
  );
}
