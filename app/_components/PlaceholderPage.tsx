import type { ReactNode } from 'react';
import Link from 'next/link';
import { Card, Icon, ListRow } from '@/components';
import styles from './placeholder-page.module.css';

export interface PlaceholderLink {
  href: string;
  label: string;
}

export interface PlaceholderPageProps {
  title: string;
  description: ReactNode;
  links?: PlaceholderLink[];
  /** DS adaptive density for the persona the page belongs to: customer pages keep the default
   * (comfortable), provider pages are `moderate`, admin pages `dense`. */
  density?: 'comfortable' | 'moderate' | 'dense';
}

/**
 * Spec 014 §7 — a nav destination whose real content belongs to a later, not-yet-implemented
 * spec gets a minimal, honest placeholder here, never a broken/fabricated page: the same pattern
 * `app/search/page.tsx` already uses for its own out-of-scope "Post a request" action. Keeps the
 * persona nav this spec ships (AC-4/AC-5/AC-6) fully reachable without pretending unbuilt
 * features exist.
 *
 * Presented as a flat DS `Card` holding the notice, with any already-built destinations as DS
 * `ListRow`s (wrapped in `next/link`, since `ListRow` itself only renders buttons/divs).
 */
export function PlaceholderPage({ title, description, links, density }: PlaceholderPageProps) {
  return (
    <main className={styles.page} data-density={density}>
      <h1 className={styles.title}>{title}</h1>
      <Card elevation="flat" padding={0} style={{ overflow: 'hidden' }}>
        <div className={styles.notice}>
          <span className={styles.noticeIcon}>
            <Icon name="info" size="md" />
          </span>
          <p className={styles.description}>{description}</p>
        </div>
        {links && links.length > 0 ? (
          <ul className={styles.links}>
            {links.map((link, i) => (
              <li key={link.href}>
                <Link href={link.href} className={styles.linkRow}>
                  <ListRow
                    title={link.label}
                    chevron
                    style={i === links.length - 1 ? { cursor: 'pointer', borderBottom: 'none' } : { cursor: 'pointer' }}
                  />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </main>
  );
}
