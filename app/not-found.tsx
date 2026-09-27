'use client';

import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';
import { useLocale } from './_components/LocaleProvider';

const linkStyle = { fontWeight: 'var(--weight-semibold)' } as const;

/** 404 UI for unmatched URLs and `notFound()` — the DS `EmptyState`, never a dead end (it links
 * back into Home and Explore). Renders inside the root layout, so the app shell stays in place. */
export default function NotFound() {
  const { t } = useLocale();
  return (
    <main style={{ maxWidth: 'var(--container-content)', margin: '0 auto', padding: 'var(--space-8) var(--space-6)' }}>
      <EmptyState
        icon="compass"
        title={t('chrome.notFound.title')}
        description={t('chrome.notFound.description')}
        action={
          <Link href="/" style={linkStyle}>
            {t('chrome.notFound.home')}
          </Link>
        }
        secondaryAction={
          <Link href="/explore" style={linkStyle}>
            {t('chrome.notFound.explore')}
          </Link>
        }
      />
    </main>
  );
}
