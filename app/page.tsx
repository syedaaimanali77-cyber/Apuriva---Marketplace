'use client';

import { useEffect, useState } from 'react';
import { Badge, Icon } from '@/components';
import { branding } from '@/lib/config/branding';

interface HealthResponse {
  status: string;
  version: string;
  db: { connected: boolean };
}

export default function HomePage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/health')
      .then((res) => res.json())
      .then((data: HealthResponse) => {
        if (!cancelled) setHealth(data);
      })
      .catch(() => {
        if (!cancelled) setHealthError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 'calc(100vh - var(--nav-top-h))',
      }}
    >
      <section
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          gap: 'var(--space-4)',
          padding: 'var(--space-20) var(--space-6)',
          background: 'var(--surface-brand-subtle)',
        }}
      >
        <h1
          style={{
            margin: 0,
            fontFamily: 'var(--font-display)',
            fontSize: 'var(--text-6xl)',
            fontWeight: 'var(--weight-bold)',
            letterSpacing: 'var(--tracking-tight)',
            color: 'var(--text-heading)',
          }}
        >
          {branding.appName}
        </h1>
        <div
          aria-hidden
          style={{
            width: 64,
            height: 4,
            borderRadius: 'var(--radius-pill)',
            background: 'var(--teal-600)',
          }}
        />
        <p
          style={{
            margin: 0,
            maxWidth: 480,
            color: 'var(--text-muted)',
            fontSize: 'var(--text-xl)',
          }}
        >
          {branding.tagline}
        </p>
      </section>

      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexWrap: 'wrap',
          gap: 'var(--space-2)',
          padding: 'var(--space-4) var(--space-6)',
          background: 'var(--surface-card)',
          borderTop: '1px solid var(--border-subtle)',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-sm)',
          color: 'var(--text-muted)',
        }}
      >
        {healthError ? (
          <Badge tone="error" icon="circle-x" size="sm">
            System unreachable
          </Badge>
        ) : health ? (
          <Badge tone={health.status === 'ok' && health.db.connected ? 'success' : 'neutral'} size="sm">
            System {health.status}
            {health.db.connected ? '' : ' · database offline'}
          </Badge>
        ) : (
          <Badge tone="neutral" icon="loader-circle" size="sm">
            Checking…
          </Badge>
        )}
        {health ? <span>v{health.version}</span> : null}
        <a
          href="/api/v1/health"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-1)',
            color: 'var(--text-link)',
            textDecoration: 'none',
          }}
        >
          Health check
          <Icon name="arrow-right" size="xs" />
        </a>
      </footer>
    </main>
  );
}
