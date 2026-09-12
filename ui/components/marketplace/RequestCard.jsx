import React from 'react';
import { Icon } from '../core/Icon.jsx';
import { Card } from '../core/Card.jsx';
import { Badge } from '../core/Badge.jsx';

const STATUS = {
  matching: ['info', 'loader-circle', 'Finding providers'],
  offers: ['brand', 'sparkles', 'Offers received'],
  selected: ['success', 'circle-check-big', 'Provider selected'],
  expired: ['neutral', 'clock', 'Expired'],
  cancelled: ['neutral', 'circle-x', 'Cancelled'],
};

export function RequestCard({
  service, description, when, location, budget, status = 'matching',
  offerCount, urgent = false, attachments, actions, onClick, style,
}) {
  const [tone, icon, label] = STATUS[status] || STATUS.matching;
  return (
    <Card interactive={Boolean(onClick)} onClick={onClick} style={{ display: 'grid', gap: 'var(--space-3)', ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Badge tone={tone} icon={icon}>{label}</Badge>
        {urgent ? <Badge tone="warning" icon="zap">Urgent</Badge> : null}
        {offerCount ? <span data-numeric style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{offerCount} offers</span> : null}
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        <h3 style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)' }}>{service}</h3>
        {description ? <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)', lineHeight: 'var(--leading-normal)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{description}</p> : null}
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
        {when ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="calendar" size="xs" color="var(--text-muted)" />{when}</span> : null}
        {location ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="map-pin" size="xs" color="var(--text-muted)" />{location}</span> : null}
        {budget ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }} data-numeric><Icon name="wallet" size="xs" color="var(--text-muted)" />{budget}</span> : null}
        {attachments ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="paperclip" size="xs" color="var(--text-muted)" />{attachments}</span> : null}
      </div>
      {actions ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div> : null}
    </Card>
  );
}
