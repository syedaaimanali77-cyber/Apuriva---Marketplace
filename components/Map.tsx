'use client';

import { Icon } from '@/ui/components/core/Icon.jsx';

export interface MapProps {
  /** Always safe to show — AC-3/AC-4. */
  approxAreaLabel: string;
  /** Present only when the viewer is authorized for exact location (owner, or post-booking). */
  latitude?: number;
  longitude?: number;
  height?: number | string;
}

/**
 * Spec 012 §5 — a thin wrapper around whatever the abstracted `lib/location` vendor turns out to
 * be (AC-6): no tile/marker rendering library is wired up because no real maps vendor is
 * selected yet (§8 risk #1, open) — only `lib/location`'s sandbox adapter exists. This renders
 * the same information a real map would (an approximate-area pin, or an exact one when
 * authorized) without depending on a specific vendor's SDK, so swapping the vendor later only
 * touches this one component, never its callers.
 */
export function Map({ approxAreaLabel, latitude, longitude, height = 200 }: MapProps) {
  const exact = latitude !== undefined && longitude !== undefined;
  return (
    <div
      role="img"
      aria-label={exact ? `Map centered on ${approxAreaLabel}` : `Approximate area: ${approxAreaLabel}`}
      style={{
        height,
        display: 'grid',
        placeItems: 'center',
        gap: 'var(--space-2)',
        borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--surface-brand-subtle)',
      }}
    >
      <Icon name="map-pin" size="lg" color="var(--teal-600)" />
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', textAlign: 'center' }}>{approxAreaLabel}</span>
      {exact ? (
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-subtle)' }}>
          {latitude!.toFixed(5)}, {longitude!.toFixed(5)}
        </span>
      ) : null}
    </div>
  );
}
