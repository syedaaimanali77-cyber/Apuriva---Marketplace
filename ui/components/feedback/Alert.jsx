import React from 'react';
import { Icon } from '../core/Icon.jsx';

const TONES = {
  info: { fg: 'var(--status-info-fg)', bg: 'var(--status-info-bg)', icon: 'info' },
  success: { fg: 'var(--status-success-fg)', bg: 'var(--status-success-bg)', icon: 'circle-check-big' },
  warning: { fg: 'var(--status-warning-fg)', bg: 'var(--status-warning-bg)', icon: 'triangle-alert' },
  error: { fg: 'var(--status-error-fg)', bg: 'var(--status-error-bg)', icon: 'circle-x' },
};

export function Alert({ tone = 'info', title, children, actions, onDismiss, style, ...rest }) {
  const t = TONES[tone] || TONES.info;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} style={{
      display: 'flex', gap: 12, padding: 'var(--space-4)', background: t.bg,
      border: `1px solid ${t.fg}22`, borderRadius: 'var(--radius-md)', ...style,
    }} {...rest}>
      <Icon name={t.icon} size="md" color={t.fg} strokeWidth={2} style={{ marginTop: 1 }} />
      <div style={{ flex: 1, display: 'grid', gap: 4 }}>
        {title ? <strong style={{ fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>{title}</strong> : null}
        {children ? <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-body)', lineHeight: 'var(--leading-normal)' }}>{children}</div> : null}
        {actions ? <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>{actions}</div> : null}
      </div>
      {onDismiss ? (
        <button type="button" aria-label="Dismiss" onClick={onDismiss} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 2, alignSelf: 'flex-start' }}>
          <Icon name="x" size="sm" />
        </button>
      ) : null}
    </div>
  );
}
