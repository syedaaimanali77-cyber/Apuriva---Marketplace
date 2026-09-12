import React from 'react';
import { Icon } from '../core/Icon.jsx';

/** Ask Apuriva conversation shell. Contextual surface — reachable from anywhere, never a
 *  permanent primary nav tab (master spec §59, AC-8 of spec 014). */
export function AiAssistantPanel({
  title = 'Ask Apuriva', subtitle = 'Suggestions only — you approve anything that costs money.',
  children, composerValue, onComposerChange, onSend, onClose, placeholder = 'Ask anything, in English or Urdu…',
  footer, style,
}) {
  return (
    <section aria-label={title} style={{
      display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%',
      background: 'var(--surface-page)', border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-xl)', overflow: 'hidden', ...style,
    }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: 'var(--space-4) var(--space-5)', background: 'var(--surface-card)', borderBottom: '1px solid var(--border-subtle)' }}>
        <span style={{ width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-circle)', background: 'var(--ai-surface)', border: '1px solid var(--ai-border)' }}>
          <Icon name="sparkles" size="sm" color="var(--ai-accent)" />
        </span>
        <span style={{ flex: 1, display: 'grid', gap: 1 }}>
          <strong style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-md)', color: 'var(--text-heading)' }}>{title}</strong>
          {subtitle ? <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{subtitle}</span> : null}
        </span>
        {onClose ? (
          <button type="button" aria-label="Close assistant" onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <Icon name="x" size="md" />
          </button>
        ) : null}
      </header>

      <div role="log" aria-live="polite" style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'grid', gap: 'var(--space-4)', alignContent: 'start', padding: 'var(--space-5)' }}>
        {children}
      </div>

      {footer}

      <form onSubmit={(e) => { e.preventDefault(); onSend && onSend(composerValue); }}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 'var(--space-3) var(--space-4)', background: 'var(--surface-card)', borderTop: '1px solid var(--border-subtle)' }}>
        <button type="button" aria-label="Attach a photo" style={{ width: 36, height: 36, display: 'grid', placeItems: 'center', border: 'none', background: 'transparent', borderRadius: 'var(--radius-circle)', cursor: 'pointer', color: 'var(--text-muted)' }}>
          <Icon name="paperclip" size="sm" />
        </button>
        <input value={composerValue} onChange={onComposerChange} placeholder={placeholder} aria-label="Message Ask Apuriva"
          style={{ flex: 1, minWidth: 0, height: 40, padding: '0 12px', border: '1px solid var(--field-border)', borderRadius: 'var(--radius-pill)', outline: 'none', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', background: 'var(--field-bg)', color: 'var(--text-heading)' }} />
        <button type="button" aria-label="Speak your request" style={{ width: 36, height: 36, display: 'grid', placeItems: 'center', border: 'none', background: 'transparent', borderRadius: 'var(--radius-circle)', cursor: 'pointer', color: 'var(--text-muted)' }}>
          <Icon name="mic" size="sm" />
        </button>
        <button type="submit" aria-label="Send" style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', border: 'none', borderRadius: 'var(--radius-circle)', cursor: 'pointer', background: 'var(--action-primary-bg)', color: 'var(--white)' }}>
          <Icon name="send" size="sm" />
        </button>
      </form>
    </section>
  );
}

/** Floating contextual launcher. */
export function AiAssistantLauncher({ label = 'Ask Apuriva', onClick, style }) {
  return (
    <button type="button" onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, height: 48, padding: '0 20px',
      border: 'none', borderRadius: 'var(--radius-pill)', cursor: 'pointer',
      background: 'var(--navy-900)', color: 'var(--white)', boxShadow: 'var(--shadow-lg)',
      fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', ...style,
    }}>
      <Icon name="sparkles" size="sm" color="var(--teal-300)" />{label}
    </button>
  );
}
