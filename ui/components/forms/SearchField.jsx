import React from 'react';
import { Icon } from '../core/Icon.jsx';

/** The marketplace search entry: text, optional voice input, and an AI-interpretation affordance. */
export function SearchField({
  value, onChange, onSubmit, placeholder = 'What do you need help with?',
  voice = true, size = 'lg', busy = false, style, ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const h = size === 'lg' ? 52 : 44;
  return (
    <form
      role="search" onSubmit={(e) => { e.preventDefault(); onSubmit && onSubmit(value); }}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, height: h, padding: '0 8px 0 14px',
        background: 'var(--field-bg)', border: `1px solid ${focus ? 'var(--field-border-focus)' : 'var(--field-border)'}`,
        borderRadius: 'var(--radius-pill)', boxShadow: focus ? 'var(--ring-focus)' : 'var(--shadow-xs)',
        transition: 'border-color var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast) var(--ease-standard)',
        ...style,
      }}
    >
      <Icon name="search" size="md" color="var(--text-muted)" />
      <input
        type="search" value={value} onChange={onChange} placeholder={placeholder} aria-label="Search Apuriva"
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} {...rest}
        style={{
          flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', color: 'var(--text-heading)',
        }}
      />
      {voice ? (
        <button type="button" aria-label="Search by voice" style={{
          width: 36, height: 36, display: 'grid', placeItems: 'center', border: 'none',
          background: 'transparent', borderRadius: 'var(--radius-circle)', cursor: 'pointer', color: 'var(--text-muted)',
        }}><Icon name="mic" size="md" /></button>
      ) : null}
      <button type="submit" aria-label="Search" disabled={busy} style={{
        height: h - 16, padding: '0 16px', display: 'inline-flex', alignItems: 'center', gap: 6,
        border: 'none', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
        background: 'var(--action-primary-bg)', color: 'var(--action-primary-fg)',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-semibold)',
      }}>
        <Icon name={busy ? 'loader-circle' : 'sparkles'} size="sm" />Search
      </button>
    </form>
  );
}
