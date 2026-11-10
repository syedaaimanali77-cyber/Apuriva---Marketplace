import React from 'react';
import { Icon } from '../core/Icon.jsx';
import { Card } from '../core/Card.jsx';
import { Badge } from '../core/Badge.jsx';
import { Avatar } from '../core/Avatar.jsx';

const STATUS = {
  upcoming: ['info', 'calendar', 'Upcoming'],
  confirmed: ['success', 'circle-check-big', 'Confirmed'],
  in_progress: ['brand', 'zap', 'In progress'],
  completed: ['success', 'circle-check-big', 'Completed'],
  cancelled: ['neutral', 'circle-x', 'Cancelled'],
  disputed: ['error', 'triangle-alert', 'Disputed'],
};

export function BookingCard({
  service, providerName, providerAvatar, when, location, price, status = 'upcoming',
  reference, actions, onClick, style,
}) {
  const [tone, icon, label] = STATUS[status] || STATUS.upcoming;
  return (
    <Card interactive={Boolean(onClick)} onClick={onClick}
      emphasis={status === 'in_progress' ? 'brand' : 'none'}
      style={{ display: 'grid', gap: 'var(--space-3)', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Badge tone={tone} icon={icon}>{label}</Badge>
        {reference ? <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-subtle)' }}>{reference}</code> : null}
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
        <Avatar src={providerAvatar} name={providerName} size="md" />
        <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2 }}>
          <h3 style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)' }}>{service}</h3>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{providerName}</span>
        </div>
        {price ? <span data-numeric style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-price)' }}>{price}</span> : null}
      </div>
      <div style={{ display: 'grid', gap: 6, fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
        {when ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Icon name="calendar" size="xs" color="var(--text-muted)" />{when}</span> : null}
        {location ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}><Icon name="map-pin" size="xs" color="var(--text-muted)" />{location}</span> : null}
      </div>
      {actions ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div> : null}
    </Card>
  );
}
