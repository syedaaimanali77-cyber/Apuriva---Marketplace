import React from 'react';
import { Icon } from '../core/Icon.jsx';
import { Button } from '../core/Button.jsx';

/** Structured, parameter-bound confirmation for a high-risk AI action (master spec §87, §90). */
export function AiConfirmationCard({
  title = 'Confirm before I continue', summary, parameters = [], riskLevel = 'high',
  confirmLabel = 'Confirm', cancelLabel = 'Not now', onConfirm, onCancel, busy = false, style,
}) {
  const risk = { medium: ['Medium risk', 'var(--status-warning-fg)', 'var(--status-warning-bg)'], high: ['Needs your approval', 'var(--status-accent-fg)', 'var(--status-accent-bg)'] }[riskLevel] || [];
  return (
    <section aria-label="Action confirmation" style={{
      display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-5)',
      background: 'var(--surface-card)', border: '1px solid var(--ai-border)',
      borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)', ...style,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 28, height: 28, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-circle)', background: 'var(--ai-surface)' }}>
          <Icon name="shield-check" size={15} color="var(--ai-accent)" />
        </span>
        <h3 style={{ flex: 1, fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)' }}>{title}</h3>
        {risk.length ? <span style={{ padding: '3px 10px', borderRadius: 'var(--radius-pill)', background: risk[2], color: risk[1], fontSize: 'var(--text-2xs)', fontWeight: 'var(--weight-semibold)', letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase' }}>{risk[0]}</span> : null}
      </div>
      {summary ? <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--text-body)', lineHeight: 'var(--leading-normal)' }}>{summary}</p> : null}
      {parameters.length ? (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', padding: 'var(--space-4)', background: 'var(--surface-sunken)', borderRadius: 'var(--radius-md)' }}>
          {parameters.map((p) => (
            <React.Fragment key={p.label}>
              <dt style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{p.label}</dt>
              <dd style={{ margin: 0, textAlign: 'end', fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>{p.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button onClick={onConfirm} loading={busy}>{confirmLabel}</Button>
        <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
      </div>
    </section>
  );
}
