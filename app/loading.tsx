import { Skeleton } from '@/components';

/** Route-level loading UI. The DS `Skeleton` supplies role="status", aria-live and an
 * assistive-tech "Loading" label; the DS uses skeletons rather than bare spinners/text. */
export default function Loading() {
  return (
    <div style={{ maxWidth: 'var(--container-content)', padding: 'var(--space-8) var(--space-6)' }}>
      <Skeleton lines={3} />
    </div>
  );
}
