import React from 'react';
import { Icon } from '../core/Icon.jsx';
import { Card } from '../core/Card.jsx';
import { Badge } from '../core/Badge.jsx';
import { Avatar } from '../core/Avatar.jsx';
import { Rating } from './Rating.jsx';
import { OfferTimer } from './OfferTimer.jsx';

export function OfferCard({
  providerName, providerAvatar, rating, reviewCount, verified = false,
  price, arrival, duration, includes = [], message, secondsRemaining, expired = false,
  topMatch = false, actions, style,
}) {
  return (
    <Card emphasis={topMatch ? 'accent' : 'none'} elevation={expired ? 'flat' : 'subtle'}
      style={{ display: 'grid', gap: 'var(--space-4)', opacity: expired ? 0.72 : 1, ...style }}>
      <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
        <Avatar src={providerAvatar} name={providerName} size="md" verified={verified} />
        <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 3 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-md)', color: 'var(--text-heading)' }}>{providerName}</strong>
            {topMatch ? <Badge tone="accent" icon="zap">Top match</Badge> : null}
          </div>
          {rating !== undefined ? <Rating value={rating} count={reviewCount} size="sm" /> : null}
        </div>
        <div style={{ textAlign: 'end' }}>
          <div data-numeric style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-2xl)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-price)', letterSpacing: 'var(--tracking-tight)', lineHeight: 1.1 }}>{price}</div>
          {duration ? <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{duration}</div> : null}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 'var(--text-sm)', color: 'var(--text-body)' }}>
        {arrival ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="clock" size="xs" color="var(--text-muted)" />{arrival}</span> : null}
        {includes.map((i) => <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><Icon name="check" size="xs" color="var(--success-600)" strokeWidth={2.4} />{i}</span>)}
      </div>

      {message ? (
        <p style={{ margin: 0, padding: 'var(--space-3)', background: 'var(--surface-sunken)', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)', color: 'var(--text-body)', lineHeight: 'var(--leading-normal)' }}>
          “{message}”
        </p>
      ) : null}

      {secondsRemaining !== undefined || expired ? <OfferTimer secondsRemaining={secondsRemaining} expired={expired} /> : null}
      {actions ? <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div> : null}
    </Card>
  );
}
