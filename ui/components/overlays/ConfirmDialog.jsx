import React from 'react';
import { Dialog } from './Dialog.jsx';
import { Button } from '../core/Button.jsx';

/** Structured confirmation for high-risk actions. Parameters are shown verbatim so the user
 *  confirms exactly what will happen (master spec §90). */
export function ConfirmDialog({
  open, onCancel, onConfirm, title, description, parameters = [],
  confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'primary', busy = false,
}) {
  return (
    <Dialog open={open} onClose={onCancel} title={title} description={description} size="sm"
      footer={<>
        <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
        <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>{confirmLabel}</Button>
      </>}>
      {parameters.length ? (
        <dl style={{
          margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px',
          padding: 'var(--space-4)', background: 'var(--surface-sunken)', borderRadius: 'var(--radius-md)',
        }}>
          {parameters.map((p) => (
            <React.Fragment key={p.label}>
              <dt style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{p.label}</dt>
              <dd style={{ margin: 0, fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)', textAlign: 'end' }}>{p.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
    </Dialog>
  );
}
