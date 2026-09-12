import React from 'react';
import { Icon } from '../core/Icon.jsx';
import { Button } from '../core/Button.jsx';

const STATE = {
  pending: ['Awaiting your approval', 'clock', 'var(--status-accent-fg)', 'var(--status-accent-bg)'],
  approved: ['Approved', 'circle-check-big', 'var(--status-success-fg)', 'var(--status-success-bg)'],
  denied: ['Denied', 'circle-x', 'var(--status-error-fg)', 'var(--status-error-bg)'],
  failed: ['Failed', 'triangle-alert', 'var(--status-error-fg)', 'var(--status-error-bg)'],
};

/** A single MCP tool call the assistant wants to run. Shows the tool's plain-language intent —
 *  never raw MCP internals (master spec §85). */
export function AiToolApproval({ toolLabel, description, args = [], state = 'pending', errorMessage, onApprove, onDeny, style }) {
  const [label, icon, fg, bg] = STATE[state] || STATE.pending;
  return (
    <div style={{
      display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-4)',
      background: 'var(--surface-card)', border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-md)', ...style,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="zap" size="sm" color="var(--ai-accent)" />
        <strong style={{ flex: 1, fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>{toolLabel}</strong>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 'var(--radius-pill)', background: bg, color: fg, fontSize: 'var(--text-2xs)', fontWeight: 'var(--weight-semibold)' }}>
          <Icon name={icon} size={11} strokeWidth={2.4} />{label}
        </span>
      </div>
      {description ? <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 'var(--leading-normal)' }}>{description}</p> : null}
      {args.length ? (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
          {args.map((a) => (
            <li key={a.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
              <span style={{ color: 'var(--text-subtle)' }}>{a.label}</span>
              <span style={{ color: 'var(--text-body)', textAlign: 'end' }}>{a.value}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {state === 'failed' && errorMessage ? (
        <p style={{ margin: 0, display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--text-sm)', color: 'var(--status-error-fg)' }}>
          <Icon name="circle-alert" size={14} strokeWidth={2} />{errorMessage}
        </p>
      ) : null}
      {state === 'pending' ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="sm" onClick={onApprove}>Allow</Button>
          <Button size="sm" variant="ghost" onClick={onDeny}>Don't allow</Button>
        </div>
      ) : null}
    </div>
  );
}
