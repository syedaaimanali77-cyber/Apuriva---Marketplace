import React from 'react';
import { Icon } from '../core/Icon.jsx';
import { Card } from '../core/Card.jsx';
import { Badge } from '../core/Badge.jsx';

const PRICE_LABEL = { fixed: '', package: 'From ', hourly: '', variable: 'Typically ', quote: '' };

export function ServiceCard({
  name, category, image, price, priceModel = 'fixed', duration, rating, reviewCount,
  badge, providerCount, onClick, style,
}) {
  return (
    <Card interactive elevation="subtle" padding={0} onClick={onClick} style={{ overflow: 'hidden', display: 'grid', gridTemplateRows: 'auto 1fr', ...style }}>
      <div style={{ position: 'relative', aspectRatio: '16 / 10', background: 'var(--surface-sunken)', display: 'grid', placeItems: 'center' }}>
        {image ? <img src={image} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <Icon name="image" size="lg" color="var(--gray-400)" />}
        {badge ? <span style={{ position: 'absolute', top: 10, insetInlineStart: 10 }}><Badge tone="accent" icon="zap" solid>{badge}</Badge></span> : null}
      </div>
      <div style={{ display: 'grid', gap: 6, padding: 'var(--space-4)', alignContent: 'start' }}>
        {category ? <span style={{ fontSize: 'var(--text-xs)', fontWeight: 'var(--weight-semibold)', letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{category}</span> : null}
        <h3 style={{ fontSize: 'var(--text-md)', fontWeight: 'var(--weight-semibold)' }}>{name}</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          {duration ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="clock" size="xs" />{duration}</span> : null}
          {providerCount !== undefined ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon name="users" size="xs" />{providerCount} providers</span> : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
          <span data-numeric style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-price)' }}>
            {priceModel === 'quote' ? <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-brand)' }}>Get offers</span>
              : <><span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-regular)', color: 'var(--text-muted)' }}>{PRICE_LABEL[priceModel]}</span>{price}{priceModel === 'hourly' ? <span style={{ fontSize: 'var(--text-sm)', fontWeight: 'var(--weight-regular)', color: 'var(--text-muted)' }}>/hr</span> : null}</>}
          </span>
          {rating !== undefined ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-sm)' }}>
              <Icon name="star" size={13} strokeWidth={0} style={{ fill: 'var(--rating-star)' }} />
              <strong data-numeric style={{ color: 'var(--text-heading)' }}>{rating.toFixed(1)}</strong>
              {reviewCount !== undefined ? <span data-numeric style={{ color: 'var(--text-muted)' }}>({reviewCount})</span> : null}
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
