import type { ReactNode } from 'react';
import Link from 'next/link';

export interface PlaceholderLink {
  href: string;
  label: string;
}

export interface PlaceholderPageProps {
  title: string;
  description: ReactNode;
  links?: PlaceholderLink[];
}

/**
 * Spec 014 §7 — a nav destination whose real content belongs to a later, not-yet-implemented
 * spec gets a minimal, honest placeholder here, never a broken/fabricated page: the same pattern
 * `app/search/page.tsx` already uses for its own out-of-scope "Post a request" action. Keeps the
 * persona nav this spec ships (AC-4/AC-5/AC-6) fully reachable without pretending unbuilt
 * features exist.
 */
export function PlaceholderPage({ title, description, links }: PlaceholderPageProps) {
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: 'var(--space-8) var(--space-6)', display: 'grid', gap: 'var(--space-3)' }}>
      <h1 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 'var(--text-3xl)', color: 'var(--text-heading)' }}>{title}</h1>
      <p style={{ margin: 0, color: 'var(--text-muted)' }}>{description}</p>
      {links && links.length > 0 ? (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 'var(--space-2)' }}>
          {links.map((link) => (
            <li key={link.href}>
              <Link href={link.href} style={{ color: 'var(--text-link)' }}>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </main>
  );
}
