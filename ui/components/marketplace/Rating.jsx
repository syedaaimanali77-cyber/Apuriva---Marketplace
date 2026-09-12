import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function Rating({ value = 0, count, size = 'md', showValue = true, style }) {
  const px = size === 'sm' ? 13 : size === 'lg' ? 18 : 15;
  const full = Math.round(value);
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}>
      <span role="img" aria-label={`${value} out of 5${count ? `, ${count} reviews` : ''}`} style={{ display: 'inline-flex', gap: 1 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Icon key={i} name="star" size={px} strokeWidth={0}
            color={i < full ? 'var(--rating-star)' : 'var(--rating-star-empty)'}
            style={{ fill: i < full ? 'var(--rating-star)' : 'var(--rating-star-empty)' }} />
        ))}
      </span>
      {showValue ? <span data-numeric style={{ fontFamily: 'var(--font-sans)', fontSize: size === 'sm' ? 'var(--text-sm)' : 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>{value.toFixed(1)}</span> : null}
      {count !== undefined ? <span data-numeric style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>({count})</span> : null}
    </span>
  );
}
