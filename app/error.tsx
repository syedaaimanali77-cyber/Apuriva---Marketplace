'use client';

import { useEffect } from 'react';
import { ErrorState } from '@/components';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    // The DS ErrorState already carries role="alert", the "Something went wrong" title and the
    // "Try again" action.
    <main style={{ maxWidth: 'var(--container-content)', margin: '0 auto', padding: 'var(--space-8) var(--space-6)' }}>
      <ErrorState onRetry={() => reset()} />
    </main>
  );
}
