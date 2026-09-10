'use client';

import { Badge } from '@/ui/components/core/Badge.jsx';
import { Card } from '@/ui/components/core/Card.jsx';
import { Icon } from '@/ui/components/core/Icon.jsx';
import { PriceDisplay } from './PriceDisplay';
import type { SearchResultDto } from '@/lib/types/search';

export interface ResultCardProps {
  result: SearchResultDto;
  onClick?: () => void;
}

/** Spec 013 §5 — one search result. `approxDistance` is only ever the coarse, bucketed label
 * `SearchResultDto` already carries (never a precise figure computed client-side); `rating` is
 * only rendered when present (spec 029 dependency, never fabricated). */
export function ResultCard({ result, onClick }: ResultCardProps) {
  return (
    <Card interactive={Boolean(onClick)} onClick={onClick} style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
        <span style={{ fontSize: 'var(--text-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-heading)' }}>
          {result.displayName}
        </span>
        {result.rating !== undefined ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-sm)' }}>
            <Icon name="star" size="xs" color="var(--warning-600)" /> {result.rating.toFixed(1)}
          </span>
        ) : null}
      </div>

      {result.approxDistance ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
          <Icon name="map-pin" size="xs" color="var(--text-subtle)" /> {result.approxDistance}
        </span>
      ) : null}

      <PriceDisplay priceDisplay={result.priceDisplay} />

      {result.badges.length > 0 ? (
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
          {result.badges.map((badge) => (
            <Badge key={badge} tone="brand" size="sm">
              {badge}
            </Badge>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
