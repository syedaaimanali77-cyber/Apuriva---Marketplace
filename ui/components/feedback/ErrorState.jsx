import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function ErrorState({ title = 'Something went wrong', description, traceId, onRetry, retryLabel = 'Try again', secondaryAction, compact = false, style }) {
  return (
    <div role="alert" style={{
      display: 'grid', justifyItems: 'center', textAlign: 'center', gap: 10,
      padding: compact ? 'var(--space-6)' : 'var(--space-12) var(--space-6)', ...style,
    }}>
      <span style={{ width: 52, height: 52, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-circle)', background: 'var(--status-error-bg)' }}>
        <Icon name="triangle-alert" size="lg" color="var(--status-error-fg)" />
      </span>
      <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' }}>{title}</h3>
      {description ? <p style={{ margin: 0, maxWidth: 420, fontSize: 'var(--text-base)', color: 'var(--text-muted)', lineHeight: 'var(--leading-normal)' }}>{description}</p> : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        {onRetry ? (
          <button type="button" onClick={onRetry} style={{
            height: 40, padding: '0 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
            background: 'var(--action-primary-bg)', color: 'var(--action-primary-fg)', border: 'none',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)',
          }}>{retryLabel}</button>
        ) : null}
        {secondaryAction}
      </div>
      {traceId ? <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>Reference: {traceId}</code> : null}
    </div>
  );
}
