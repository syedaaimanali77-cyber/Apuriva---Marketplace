// The module itself, not the `@/components` barrel: this is a SERVER component in the root segment, and a
// server import of the barrel makes every `'use client'` component it re-exports a client reference of
// this segment, so all of them would ship on every route (spec 044 initial JS).
import { Skeleton } from '@/components/Skeleton';

/** Route-level loading UI. The DS `Skeleton` supplies role="status", aria-live and an
 * assistive-tech "Loading" label; the DS uses skeletons rather than bare spinners/text. */
export default function Loading() {
  return (
    <div style={{ maxWidth: 'var(--container-content)', padding: 'var(--space-8) var(--space-6)' }}>
      <Skeleton lines={3} />
    </div>
  );
}
