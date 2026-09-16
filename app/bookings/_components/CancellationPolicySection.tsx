'use client';

import { useEffect, useState } from 'react';
import { Card, Skeleton } from '@/components';
import type { CancellationPolicyDto, CancellationTier } from '@/lib/types/cancellation';
import { apiFetch } from '../booking-client';
import styles from '../bookings.module.css';

/**
 * Spec 023 §5 — the policy a customer sees BEFORE paying (AC-1).
 *
 * It reads the BOOKING-scoped route, which returns the version snapshotted for this booking rather
 * than a re-resolution of current configuration. That is the whole point: what is displayed here is
 * what will be enforced if the booking is later cancelled, even if an admin publishes a new policy
 * in between.
 *
 * Built from existing primitives (`Card`, `Skeleton`) and the booking screens' existing module CSS.
 * No design-system token, primitive or `ui/` file is added or changed, and no brand mark: the nav
 * shell already carries the one intentional placement.
 */
export function describeTier(tier: CancellationTier): string {
  const { minHoursBefore, maxHoursBefore } = tier;
  if (minHoursBefore === null) return 'At or after the scheduled time';
  if (maxHoursBefore === null) return `${minHoursBefore} hours or more before`;
  if (minHoursBefore === 0) return `Less than ${maxHoursBefore} hours before`;
  return `${minHoursBefore}–${maxHoursBefore} hours before`;
}

export function describeFee(feePercent: number): string {
  if (feePercent === 0) return 'Free';
  if (feePercent === 100) return 'No refund';
  return `${feePercent}% fee`;
}

export function CancellationPolicySection({ bookingId }: { bookingId: string }) {
  const [policy, setPolicy] = useState<CancellationPolicyDto | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await apiFetch<CancellationPolicyDto>(`/api/v1/bookings/${bookingId}/cancellation-policy`);
      if (cancelled) return;
      // Only a payload that actually carries a tier ladder is treated as a policy. A `404`, an error
      // envelope, or any unexpected shape renders nothing — a booking screen must never break
      // because one supplementary section could not be loaded.
      const data = result.ok ? result.data : undefined;
      setPolicy(data && Array.isArray(data.tiers) && data.tiers.length > 0 ? data : null);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  if (!loaded) {
    return (
      <section className={styles.section}>
        <Skeleton />
      </section>
    );
  }

  // A booking whose policy cannot be read renders nothing at all rather than an empty-state card —
  // an absent section is quieter and more honest than a box explaining its own emptiness.
  if (!policy) return null;

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Cancellation policy</h2>
      <Card>
        <ul className={styles.historyList}>
          {policy.tiers.map((tier) => (
            <li key={`${tier.minHoursBefore}-${tier.maxHoursBefore}`} className={styles.historyRow}>
              <span>{describeTier(tier)}</span>
              <span>{describeFee(tier.feePercent)}</span>
            </li>
          ))}
        </ul>
        <p className={styles.hint}>
          Fees are calculated from the amount charged, using the time of your cancellation. These are the terms that
          applied when this booking was made — later policy changes do not affect it.
        </p>
      </Card>
    </section>
  );
}
