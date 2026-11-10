import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Drawer({ open, onClose, title, side = 'end', size = 380, children, footer, style }) {
  React.useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose && onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  const bottom = side === 'bottom';
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-drawer)', background: 'var(--surface-overlay-scrim)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose && onClose(); }}>
      <aside role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : 'Panel'}
        style={{
          position: 'absolute', background: 'var(--surface-card)', display: 'flex', flexDirection: 'column',
          boxShadow: 'var(--shadow-overlay)',
          ...(bottom
            ? { insetInline: 0, bottom: 0, maxHeight: '86vh', borderTopLeftRadius: 'var(--radius-xl)', borderTopRightRadius: 'var(--radius-xl)', animation: 'apr-drawer-up var(--duration-normal) var(--ease-out)' }
            : { top: 0, bottom: 0, [side === 'start' ? 'insetInlineStart' : 'insetInlineEnd']: 0, width: 'min(' + size + 'px, 92vw)', animation: 'apr-drawer-in var(--duration-normal) var(--ease-out)' }),
          ...style,
        }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 'var(--space-4) var(--space-5)', borderBottom: '1px solid var(--border-subtle)' }}>
          {bottom ? <span aria-hidden="true" style={{ position: 'absolute', top: 8, insetInlineStart: '50%', transform: 'translateX(-50%)', width: 36, height: 4, borderRadius: 2, background: 'var(--gray-300)' }} /> : null}
          <h2 style={{ flex: 1, fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)' }}>{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', padding: 4 }}>
            <Icon name="x" size="md" />
          </button>
        </header>
        <div style={{ flex: 1, overflow: 'auto', padding: 'var(--space-5)' }}>{children}</div>
        {footer ? <footer style={{ display: 'flex', gap: 8, padding: 'var(--space-4) var(--space-5)', borderTop: '1px solid var(--border-subtle)' }}>{footer}</footer> : null}
        <style>{'@keyframes apr-drawer-in{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}@keyframes apr-drawer-up{from{transform:translateY(16px);opacity:0}to{transform:none;opacity:1}}'}</style>
      </aside>
    </div>
  );
}
