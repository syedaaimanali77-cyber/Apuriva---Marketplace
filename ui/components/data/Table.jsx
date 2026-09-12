import React from 'react';

export function Table({ columns = [], rows = [], caption, density = 'dense', onRowClick, emptyMessage = 'Nothing to show', style }) {
  const padY = density === 'dense' ? 8 : 12;
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', background: 'var(--surface-card)', ...style }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)' }}>
        {caption ? <caption className="apr-visually-hidden">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" style={{
                textAlign: c.align || 'start', padding: `10px 14px`, whiteSpace: 'nowrap',
                background: 'var(--surface-sunken)', borderBottom: '1px solid var(--border-subtle)',
                fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-semibold)',
                letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase', color: 'var(--text-muted)',
                width: c.width,
              }}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} style={{ padding: 'var(--space-8)', textAlign: 'center', color: 'var(--text-muted)' }}>{emptyMessage}</td></tr>
          ) : rows.map((r, i) => (
            <tr key={r.id || i} onClick={onRowClick ? () => onRowClick(r) : undefined}
              style={{ cursor: onRowClick ? 'pointer' : undefined, borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--border-subtle)' }}
              onMouseEnter={(e) => { if (onRowClick) e.currentTarget.style.background = 'var(--gray-50)'; }}
              onMouseLeave={(e) => { if (onRowClick) e.currentTarget.style.background = 'transparent'; }}>
              {columns.map((c) => (
                <td key={c.key} style={{
                  padding: `${padY}px 14px`, textAlign: c.align || 'start', color: 'var(--text-body)',
                  fontVariantNumeric: c.numeric ? 'tabular-nums' : undefined, verticalAlign: 'middle',
                }}>{c.render ? c.render(r) : r[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
