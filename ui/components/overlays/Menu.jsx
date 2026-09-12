import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Menu({ trigger, items = [], align = 'end', style }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block', ...style }}>
      <span onClick={() => setOpen((o) => !o)} style={{ display: 'inline-flex' }}>
        {React.isValidElement(trigger) ? React.cloneElement(trigger, { 'aria-haspopup': 'menu', 'aria-expanded': open }) : trigger}
      </span>
      {open ? (
        <div role="menu" style={{
          position: 'absolute', top: 'calc(100% + 6px)', [align === 'start' ? 'insetInlineStart' : 'insetInlineEnd']: 0,
          minWidth: 200, zIndex: 'var(--z-overlay)', padding: 6,
          background: 'var(--surface-card)', border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)',
          animation: 'apr-menu-in var(--duration-fast) var(--ease-out)',
        }}>
          {items.map((it, i) => it.separator ? (
            <hr key={i} style={{ margin: '6px 4px', border: 'none', borderTop: '1px solid var(--border-subtle)' }} />
          ) : (
            <button key={i} role="menuitem" type="button" disabled={it.disabled}
              onClick={() => { setOpen(false); it.onSelect && it.onSelect(); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%', minHeight: 36, padding: '0 10px',
                border: 'none', background: 'transparent', borderRadius: 'var(--radius-sm)', cursor: it.disabled ? 'not-allowed' : 'pointer',
                fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', textAlign: 'start',
                color: it.tone === 'danger' ? 'var(--status-error-fg)' : 'var(--text-body)', opacity: it.disabled ? 0.5 : 1,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--gray-100)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              {it.icon ? <Icon name={it.icon} size="sm" /> : null}
              <span style={{ flex: 1 }}>{it.label}</span>
              {it.checked ? <Icon name="check" size="sm" color="var(--teal-600)" /> : null}
            </button>
          ))}
          <style>{'@keyframes apr-menu-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}'}</style>
        </div>
      ) : null}
    </div>
  );
}
