import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Dialog({ open, onClose, title, description, children, footer, size = 'md', dismissible = true, style }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && dismissible) onClose && onClose(); };
    document.addEventListener('keydown', onKey);
    const node = ref.current;
    if (node) { const first = node.querySelector('button,[href],input,select,textarea,[tabindex]'); first && first.focus(); }
    return () => document.removeEventListener('keydown', onKey);
  }, [open, dismissible, onClose]);
  if (!open) return null;
  const width = { sm: 380, md: 520, lg: 720 }[size] || 520;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 'var(--z-dialog)', display: 'grid', placeItems: 'center',
      padding: 'var(--space-4)', background: 'var(--surface-overlay-scrim)',
      animation: 'apr-fade var(--duration-fast) var(--ease-standard)',
    }} onMouseDown={(e) => { if (dismissible && e.target === e.currentTarget) onClose && onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}
        style={{
          width: 'min(' + width + 'px, 100%)', maxHeight: '86vh', overflow: 'auto',
          background: 'var(--surface-card)', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-overlay)',
          animation: 'apr-dialog-in var(--duration-normal) var(--ease-out)', ...style,
        }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: 'var(--space-6) var(--space-6) 0' }}>
          <div style={{ flex: 1, display: 'grid', gap: 4 }}>
            {title ? <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 'var(--weight-semibold)' }}>{title}</h2> : null}
            {description ? <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--text-muted)', lineHeight: 'var(--leading-normal)' }}>{description}</p> : null}
          </div>
          {dismissible ? (
            <button type="button" aria-label="Close" onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, marginTop: -4 }}>
              <Icon name="x" size="md" />
            </button>
          ) : null}
        </div>
        {children ? <div style={{ padding: 'var(--space-5) var(--space-6)' }}>{children}</div> : <div style={{ height: 'var(--space-5)' }} />}
        {footer ? <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 'var(--space-4) var(--space-6)', borderTop: '1px solid var(--border-subtle)' }}>{footer}</div> : null}
      </div>
      <style>{'@keyframes apr-fade{from{opacity:0}to{opacity:1}}@keyframes apr-dialog-in{from{opacity:0;transform:translateY(10px) scale(.99)}to{opacity:1;transform:none}}'}</style>
    </div>
  );
}
