import React from 'react';
import { Icon } from '../core/Icon.jsx';

let uid = 0;
export function useFieldIds(id) {
  const ref = React.useRef(null);
  if (!ref.current) ref.current = id || `apr-field-${++uid}`;
  return { id: ref.current, helpId: `${ref.current}-help`, errorId: `${ref.current}-error` };
}

/**
 * Label + control + help/error wrapper. Every Apuriva form control is wrapped in one of these so
 * the label, description and error are always programmatically associated.
 */
export function FormField({ label, htmlFor, help, error, required = false, optional = false, children, style }) {
  return (
    <div style={{ display: 'grid', gap: 6, ...style }}>
      {label ? (
        <label htmlFor={htmlFor} style={{
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)',
          color: 'var(--field-label)', display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {label}
          {required ? <span aria-hidden="true" style={{ color: 'var(--error-600)' }}>*</span> : null}
          {optional ? <span style={{ fontWeight: 'var(--weight-regular)', color: 'var(--text-subtle)' }}>Optional</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p id={htmlFor ? `${htmlFor}-error` : undefined} style={{
          margin: 0, display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 'var(--text-sm)', color: 'var(--status-error-fg)',
        }}>
          <Icon name="circle-alert" size={14} strokeWidth={2} />{error}
        </p>
      ) : help ? (
        <p id={htmlFor ? `${htmlFor}-help` : undefined} style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--field-help)' }}>{help}</p>
      ) : null}
    </div>
  );
}
