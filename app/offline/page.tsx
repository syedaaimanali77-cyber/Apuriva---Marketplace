import type { Metadata } from 'next';
import { EmptyState } from '@/components/EmptyState';
import { getRequestLocale } from '@/lib/i18n/server';
import { translate } from '@/lib/i18n/translate';
import { noindexMetadata } from '@/lib/seo/route-policy';

/**
 * Spec 044 §3.2/§5 — the page the service worker serves when a navigation cannot reach the server. The
 * worker fetches it at install WITHOUT credentials, so it is always the anonymous guest rendering and can
 * hold nothing private. It is `noindex` itself (§3.8: `/offline` has no segment layout).
 *
 * "Try again" is a plain link to the current URL: when the worker served this page for a failed navigation,
 * following it retries that navigation.
 */
export const metadata: Metadata = noindexMetadata();

export default async function OfflinePage() {
  const { locale } = await getRequestLocale();
  return (
    <main style={{ maxWidth: 'var(--container-content)', margin: '0 auto', padding: 'var(--space-8) var(--space-6)' }}>
      <EmptyState
        icon="globe"
        title={translate(locale, 'offline.heading')}
        description={translate(locale, 'offline.body')}
        action={
          <a href="" style={{ fontWeight: 'var(--weight-semibold)' }}>
            {translate(locale, 'offline.retry')}
          </a>
        }
      />
    </main>
  );
}
