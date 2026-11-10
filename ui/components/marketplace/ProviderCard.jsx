import React from 'react';
import { Icon } from '../core/Icon.jsx';
import { Card } from '../core/Card.jsx';
import { Badge } from '../core/Badge.jsx';
import { Avatar } from '../core/Avatar.jsx';
import { Rating } from './Rating.jsx';

const AVAILABILITY = {
  available: ['success', 'circle-check-big', 'Available'],
  busy: ['warning', 'clock', 'Busy'],
  unavailable: ['neutral', 'circle-x', 'Unavailable'],
};

export function ProviderCard({
  name, headline, avatar, rating, reviewCount, distance, verified = false,
  availability = 'available', priceFrom, tags = [], topMatch = false, reason,
  actions, onClick, style,
}) {
  const [tone, icon, label] = AVAILABILITY[availability] || AVAILABILITY.available;
  return (
    <Card interactive={Boolean(onClick)} onClick={onClick} emphasis={topMatch ? 'accent' : 'none'} style={{ display: 'grid', gap: 'var(--space-3)', ...style }}>
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        <Avatar src={avatar} name={name} size="lg" verified={verified} />
        <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 3 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)' }}>{name}</h3>
            {topMatch ? <Badge tone="accent" icon="zap">Top match</Badge> : null}
          </div>
          {headline ? <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{headline}</p> : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 2 }}>
            {rating !== undefined ? <Rating value={rating} count={reviewCount} size="sm" /> : null}
            {distance ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}><Icon name="map-pin" size="xs" />{distance}</span> : null}
          </div>
        </div>
        {priceFrom ? (
          <div style={{ textAlign: 'end' }}>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>From</div>
            <div data-numeric style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-price)' }}>{priceFrom}</div>
          </div>
        ) : null}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Badge tone={tone} icon={icon}>{label}</Badge>
        {verified ? <Badge tone="brand" icon="shield-check">Verified</Badge> : null}
        {tags.map((t) => <Badge key={t} tone="neutral" icon={null}>{t}</Badge>)}
      </div>
      {reason ? (
        <p style={{
          margin: 0, display: 'flex', gap: 8, alignItems: 'flex-start', padding: 'var(--space-3)',
          background: 'var(--ai-surface)', border: '1px solid var(--ai-border)', borderRadius: 'var(--radius-md)',
          fontSize: 'var(--text-sm)', color: 'var(--text-body)', lineHeight: 'var(--leading-normal)',
        }}>
          <Icon name="sparkles" size="xs" color="var(--ai-accent)" style={{ marginTop: 3 }} />
          <span><strong style={{ color: 'var(--text-brand)' }}>Why this provider: </strong>{reason}</span>
        </p>
      ) : null}
      {actions ? <div style={{ display: 'flex', gap: 8 }}>{actions}</div> : null}
    </Card>
  );
}
