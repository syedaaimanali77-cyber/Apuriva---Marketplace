'use client';

import type { ReactNode } from 'react';
import { Badge, Card, Icon, Logo } from '@/components';
import { branding } from '@/lib/config/branding';
import styles from '../auth.module.css';

const VALUE_PROPS: { icon: string; text: string }[] = [
  { icon: 'shield-check', text: 'Verified providers you can trust' },
  { icon: 'zap', text: 'Fast, transparent offers — no back-and-forth' },
  { icon: 'star', text: 'Rated and reviewed by real customers' },
];

export interface AuthShellProps {
  /** Large headline on the desktop brand panel. Defaults to the brand tagline. */
  brandHeadline?: string;
  children: ReactNode;
  /** Rendered centered below the card, e.g. "No account? Register". */
  footer: ReactNode;
}

/**
 * Shared visual shell for `app/(auth)/login` and `app/(auth)/register` (spec 005 §5) — a
 * decorative brand panel (desktop/tablet) or a compact brand strip (mobile) next to/above an
 * elevated form card. Purely presentational: every page keeps full ownership of its own
 * heading, form fields, handlers, and API calls — this component only supplies layout and
 * branding, built entirely from `components`/`ui/` primitives and tokens.
 *
 * Branding uses the DS `Logo` wordmark rather than the logo artwork: the only supplied artwork
 * (ui/assets/apuriva-logo-full.jpeg) is a raster lockup on a white background, which the DS
 * readme reserves for light surfaces — the brand panel is a dark gradient, and `Logo` without
 * `src` is the DS's own fallback for exactly that case.
 */
export function AuthShell({ brandHeadline, children, footer }: AuthShellProps) {
  return (
    // data-app-shell="none": no nav renders on these routes, so the layout reserves no space for it.
    <div className={styles.shell} data-app-shell="none">
      <aside className={styles.brandPanel} aria-hidden="true">
        <div className={styles.brandGlow} />
        <div className={styles.brandContent}>
          <div className={styles.brandLockup}>
            <Logo tone="light" size={24} />
          </div>
          <h2 className={styles.brandHeadline}>{brandHeadline ?? branding.tagline}</h2>
          <p className={styles.brandSubline}>
            Pakistan&rsquo;s trusted marketplace for getting real work done — from home repairs to
            professional services, matched and booked in minutes.
          </p>
          <ul className={styles.valueList}>
            {VALUE_PROPS.map((item) => (
              <li key={item.text} className={styles.valueItem}>
                <span className={styles.valueIcon}>
                  <Icon name={item.icon} size="sm" />
                </span>
                {item.text}
              </li>
            ))}
          </ul>
          <Badge tone="brand" icon="badge-check" className={styles.trustChip}>
            Trusted across Pakistan
          </Badge>
        </div>
      </aside>

      <div className={styles.formPanel}>
        <div className={styles.formPanelInner}>
          <div className={styles.mobileBrand} aria-hidden="true">
            <Logo size={20} />
            <p className={styles.mobileBrandTagline}>{branding.tagline}</p>
          </div>

          <Card
            elevation="overlay"
            style={{ borderRadius: 'var(--radius-2xl)', border: 'none', padding: 'var(--auth-card-pad)' }}
          >
            <div className={styles.card}>{children}</div>
          </Card>

          <p className={styles.footer}>{footer}</p>
        </div>
      </div>
    </div>
  );
}
