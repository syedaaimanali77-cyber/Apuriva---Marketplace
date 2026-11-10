'use client';

import { useEffect, useState } from 'react';
import { Card, Skeleton } from '@/components';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { Translator } from '@/lib/i18n/translator';
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
export function describeTier(t: Translator, tier: CancellationTier): string {
  const { minHoursBefore, maxHoursBefore } = tier;
  if (minHoursBefore === null) return t('bookingCancel.tier.atOrAfter');
  if (maxHoursBefore === null) return t('bookingCancel.tier.orMore', { hours: minHoursBefore });
  if (minHoursBefore === 0) return t('bookingCancel.tier.lessThan', { hours: maxHoursBefore });
  return t('bookingCancel.tier.between', { min: minHoursBefore, max: maxHoursBefore });
}

export function describeFee(t: Translator, feePercent: number): string {
  if (feePercent === 0) return t('bookingCancel.feeRule.free');
  if (feePercent === 100) return t('bookingCancel.feeRule.noRefund');
  return t('bookingCancel.feeRule.percent', { percent: feePercent });
}

export function CancellationPolicySection({ bookingId }: { bookingId: string }) {
  const { t } = useLocale();
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
      <h2 className={styles.sectionTitle}>{t('bookingCancel.policyTitle')}</h2>
      <Card>
        <ul className={styles.historyList}>
          {policy.tiers.map((tier) => (
            <li key={`${tier.minHoursBefore}-${tier.maxHoursBefore}`} className={styles.historyRow}>
              <span>{describeTier(t, tier)}</span>
              <span>{describeFee(t, tier.feePercent)}</span>
            </li>
          ))}
        </ul>
        <p className={styles.hint}>{t('bookingCancel.policyHint')}</p>
      </Card>
    </section>
  );
}
