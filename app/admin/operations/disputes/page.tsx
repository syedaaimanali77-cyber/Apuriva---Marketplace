'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Card, EmptyState, ErrorState, Skeleton } from '@/components';
import { apiFetch } from '@/app/requests/api-client';
import type { AdminDisputeSummaryDto, DisputeStatus } from '@/lib/types/disputes';
import styles from '../../admin.module.css';

const STATUS_LABELS: Record<DisputeStatus, string> = {
  open: 'Open',
  under_review: 'Being reviewed',
  resolved: 'Decided',
  appealed: 'Under appeal',
  closed: 'Closed',
};

/**
 * Spec 031 §5 — the Trust & Safety dispute queue.
 *
 * ORDERING IS THE SERVER'S: live disputes first, then `created_at ASC`, i.e. FIFO among equals, so
 * nothing waits indefinitely because something newer keeps arriving. This screen does not re-sort.
 *
 * THE SUMMARY DELIBERATELY CARRIES NO SUBSTANCE — no reason, no decision, no names. Scanning the
 * queue is already an audited act (`disputes.queue_read`); putting the parties' words on a list
 * view would spread them further than the decision requires. The detail screen is where a case is
 * actually read, and opening it is audited separately.
 *
 * Built from existing primitives and the existing admin module CSS. No new design-system primitive,
 * no raw visual value, no brand mark.
 */
export default function AdminDisputeQueuePage() {
  const [disputes, setDisputes] = useState<AdminDisputeSummaryDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await apiFetch<AdminDisputeSummaryDto[]>('/api/v1/admin/disputes');
    if (!response.ok) {
      setError(response.error?.message ?? 'The dispute queue could not be loaded.');
      setDisputes([]);
      return;
    }
    setDisputes(response.data ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (disputes === null) {
    return (
      <main className={styles.page}>
        <h1>Disputes</h1>
        <Skeleton height={48} />
        <Skeleton height={48} />
        <Skeleton height={48} />
      </main>
    );
  }

  if (error) {
    return (
      <main className={styles.page}>
        <h1>Disputes</h1>
        <ErrorState title="We could not load the dispute queue" description={error} />
      </main>
    );
  }

  const live = disputes.filter((dispute) => dispute.status !== 'closed');

  return (
    <main className={styles.page}>
      <h1>Disputes</h1>
      {live.length === 0 ? (
        <EmptyState title="Queue clear — no open disputes" />
      ) : (
        <ul>
          {live.map((dispute) => (
            <li key={dispute.id}>
              <Card>
                <Badge>{STATUS_LABELS[dispute.status]}</Badge>
                {dispute.hasProposedRefund ? <Badge>Refund proposed</Badge> : null}
                {dispute.legalHold ? <Badge>Legal hold</Badge> : null}
                <p>Opened {new Date(dispute.createdAt).toLocaleDateString('en-GB')}</p>
                <p>{dispute.claimedByAdminUserId ? 'Claimed' : 'Unclaimed'}</p>
                <Link href={`/admin/operations/disputes/${dispute.id}`}>Open this dispute</Link>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
