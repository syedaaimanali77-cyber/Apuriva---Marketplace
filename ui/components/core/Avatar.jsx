import React from 'react';
import { Icon } from './Icon.jsx';

const SIZES = { xs: 24, sm: 32, md: 40, lg: 56, xl: 80 };

export function Avatar({ src, name = '', size = 'md', shape = 'circle', verified = false, style, ...rest }) {
  const px = typeof size === 'number' ? size : SIZES[size] || SIZES.md;
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <span style={{ position: 'relative', display: 'inline-block', flexShrink: 0, ...style }} {...rest}>
      <span
        aria-hidden={!name || undefined}
        style={{
          width: px, height: px, display: 'grid', placeItems: 'center', overflow: 'hidden',
          borderRadius: shape === 'circle' ? 'var(--radius-circle)' : 'var(--radius-md)',
          background: src ? 'var(--gray-200)' : 'var(--navy-100)', color: 'var(--navy-800)',
          fontFamily: 'var(--font-display)', fontWeight: 'var(--weight-semibold)',
          fontSize: Math.round(px * 0.36), letterSpacing: 'var(--tracking-snug)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {src ? <img src={src} alt={name ? `${name}` : ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : initials || <Icon name="user" size={Math.round(px * 0.5)} color="var(--gray-400)" />}
      </span>
      {verified ? (
        <span title="Verified" style={{
          position: 'absolute', insetInlineEnd: -2, bottom: -2, width: Math.max(14, px * 0.34), height: Math.max(14, px * 0.34),
          display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-circle)',
          background: 'var(--verified)', border: '2px solid var(--white)',
        }}>
          <Icon name="check" size={Math.max(8, px * 0.2)} color="var(--white)" strokeWidth={3} />
        </span>
      ) : null}
    </span>
  );
}
