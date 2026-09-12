import React from 'react';
import { Icon } from '../core/Icon.jsx';
import { Avatar } from '../core/Avatar.jsx';

/** Priority banner on Home when the customer has an active booking (master spec §13). */
export function ActiveBookingBanner({ status = 'Provider on the way', service, providerName, providerAvatar, when, action, onClick, style }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 'var(--space-4)',
      padding: 'var(--space-4) var(--space-5)', background: 'var(--surface-inverse)',
      borderRadius: 'var(--radius-xl)', color: 'var(--white)',
      cursor: onClick ? 'pointer' : undefined, ...style,
    }}>
      <Avatar src={providerAvatar} name={providerName} size="md" />
      <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 3 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-semibold)', letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase', color: 'var(--teal-300)' }}>
          <Icon name="zap" size={12} strokeWidth={2.4} />{status}
        </span>
        <strong style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-md)' }}>{service}</strong>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--navy-100)' }}>{providerName}{when ? ' · ' + when : ''}</span>
      </div>
      {action}
    </div>
  );
}
