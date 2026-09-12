import Link from 'next/link';
import { EmptyState } from '@/components/EmptyState';

const linkStyle = { fontWeight: 'var(--weight-semibold)' } as const;

/** 404 UI for unmatched URLs and `notFound()` — the DS `EmptyState`, never a dead end (it links
 * back into Home and Explore). Renders inside the root layout, so the app shell stays in place. */
export default function NotFound() {
  return (
    <main style={{ maxWidth: 'var(--container-content)', margin: '0 auto', padding: 'var(--space-8) var(--space-6)' }}>
      <EmptyState
        icon="compass"
        title="Page not found"
        description="The page you're looking for doesn't exist or may have moved."
        action={
          <Link href="/" style={linkStyle}>
            Go to Home
          </Link>
        }
        secondaryAction={
          <Link href="/explore" style={linkStyle}>
            Explore services
          </Link>
        }
      />
    </main>
  );
}
