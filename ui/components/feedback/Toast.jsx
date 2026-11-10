import React from 'react';
import { Icon } from '../core/Icon.jsx';

const TONES = {
  success: ['var(--status-success-fg)', 'circle-check-big'],
  error: ['var(--status-error-fg)', 'circle-x'],
  info: ['var(--status-info-fg)', 'info'],
  warning: ['var(--status-warning-fg)', 'triangle-alert'],
};

export function Toast({ tone = 'success', title, description, action, onDismiss, style, ...rest }) {
  const [fg, icon] = TONES[tone] || TONES.info;
  return (
    <div role="status" aria-live="polite" style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, width: 'min(380px,92vw)',
      padding: '14px 14px 14px 16px', background: 'var(--surface-card)',
      border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
      boxShadow: 'var(--shadow-lg)',
      animation: 'apr-toast-in var(--duration-normal) var(--ease-out)',
      ...style,
    }} {...rest}>
      <Icon name={icon} size="md" color={fg} strokeWidth={2} />
      <div style={{ flex: 1, display: 'grid', gap: 2 }}>
        <strong style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>{title}</strong>
        {description ? <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{description}</span> : null}
      </div>
      {action}
      {onDismiss ? (
        <button type="button" aria-label="Dismiss" onClick={onDismiss} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-subtle)', padding: 2 }}>
          <Icon name="x" size="sm" />
        </button>
      ) : null}
      <style>{'@keyframes apr-toast-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}'}</style>
    </div>
  );
}

export function ToastViewport({ children, position = 'bottom-right', style }) {
  const pos = {
    'bottom-right': { bottom: 24, insetInlineEnd: 24 },
    'bottom-center': { bottom: 24, insetInlineStart: '50%', transform: 'translateX(-50%)' },
    'top-right': { top: 24, insetInlineEnd: 24 },
  }[position];
  return <div style={{ position: 'fixed', zIndex: 'var(--z-toast)', display: 'grid', gap: 10, ...pos, ...style }}>{children}</div>;
}
