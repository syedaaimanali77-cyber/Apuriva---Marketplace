import React from 'react';

export function Textarea({ rows = 4, invalid = false, disabled = false, maxLength, value, style, ...rest }) {
  const [focus, setFocus] = React.useState(false);
  const border = invalid ? 'var(--field-border-error)' : focus ? 'var(--field-border-focus)' : 'var(--field-border)';
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <textarea
        rows={rows} disabled={disabled} maxLength={maxLength} value={value}
        aria-invalid={invalid || undefined}
        onFocus={(e) => { setFocus(true); rest.onFocus && rest.onFocus(e); }}
        onBlur={(e) => { setFocus(false); rest.onBlur && rest.onBlur(e); }}
        {...rest}
        style={{
          width: '100%', padding: '10px 12px', resize: 'vertical',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', lineHeight: 'var(--leading-normal)',
          color: 'var(--text-heading)', background: disabled ? 'var(--field-bg-disabled)' : 'var(--field-bg)',
          border: `1px solid ${border}`, borderRadius: 'var(--radius-md)', outline: 'none',
          boxShadow: focus ? (invalid ? 'var(--ring-error)' : 'var(--ring-focus)') : 'none',
          transition: 'border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)',
          ...style,
        }}
      />
      {maxLength ? (
        <span aria-live="polite" style={{ justifySelf: 'end', fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }} data-numeric>
          {String(value || '').length}/{maxLength}
        </span>
      ) : null}
    </div>
  );
}
