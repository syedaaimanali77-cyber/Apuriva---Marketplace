'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import type { OperationsQueueItemDto, OperationsQueueItemType, OperationsQueuePriority } from '@/lib/types/admin-dashboard';
import type { PagedResponse } from '@/lib/types/api';
import styles from '../admin.module.css';
import dashboard from '../_components/admin-dashboard.module.css';
import { usePolledResource } from '../_components/usePolledResource';

const QUEUE_PAGE_SIZE = 20;

const TYPE_LABEL: Record<OperationsQueueItemType, string> = {
  dispute: 'Dispute',
  support_ticket: 'Support ticket',
  safety_report: 'Safety report',
};

const PRIORITY_TONE: Record<OperationsQueuePriority, 'neutral' | 'info' | 'warning' | 'error'> = {
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'error',
};

interface QueuePage {
  items: OperationsQueueItemDto[];
  total: number;
  nextOffset: number | null;
}

function selectQueue(json: unknown): QueuePage {
  const body = json as PagedResponse<OperationsQueueItemDto>;
  return { items: body.data, total: body.page.total, nextOffset: body.page.nextOffset };
}

const COLUMNS: TableColumn<OperationsQueueItemDto>[] = [
  { key: 'type', header: 'Item', render: (row) => TYPE_LABEL[row.type] },
  { key: 'status', header: 'Status', render: (row) => row.status.replace(/_/g, ' ') },
  {
    key: 'priority',
    header: 'Priority',
    render: (row) => (row.priority ? <Badge tone={PRIORITY_TONE[row.priority]}>{row.priority}</Badge> : '—'),
  },
  { key: 'createdAt', header: 'Opened', render: (row) => new Date(row.createdAt).toLocaleString() },
  { key: 'open', header: 'Details', render: (row) => <Link href={row.linkTo}>Open</Link> },
];

/**
 * Spec 037 §5, `/admin/operations` — the unified queue of disputes, support tickets and safety
 * reports needing attention (`GET /api/v1/admin/operations/queue`), each source shown only if the
 * server says this admin may read it. Polled every 10 s. Each row links to its existing workflow;
 * nothing is acted on here. The existing workspace links stay.
 */
export default function AdminOperationsPage() {
  const [offset, setOffset] = useState(0);
  const queue = usePolledResource(
    `/api/v1/admin/operations/queue?limit=${QUEUE_PAGE_SIZE}&offset=${offset}`,
    selectQueue,
    { poll: true },
  );

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>Operations</h1>

      <section className={styles.section} aria-labelledby="operations-queue">
        <div className={styles.sectionHeader}>
          <h2 id="operations-queue" className={styles.sectionTitle}>
            Needs attention
          </h2>
        </div>

        {queue.status === 'loading' && (
          <Card>
            <Skeleton lines={4} />
          </Card>
        )}

        {queue.status === 'forbidden' && (
          <Alert tone="warning" title="Administrator access required">
            The operations queue is available to APURIVA administrators only.
          </Alert>
        )}

        {queue.status === 'error' && <ErrorState description={queue.error ?? undefined} onRetry={queue.retry} />}

        {queue.status === 'ready' && queue.data && (
          <>
            {queue.pollFailed && (
              <Alert tone="warning" title="Couldn't refresh">
                Showing the last queue loaded.
              </Alert>
            )}
            {queue.data.items.length === 0 ? (
              <EmptyState title="No items need attention" />
            ) : (
              <>
                <Table caption="Items needing attention" density="dense" columns={COLUMNS} rows={queue.data.items} />
                <div className={styles.actions}>
                  <Button
                    variant="secondary"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - QUEUE_PAGE_SIZE))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={queue.data.nextOffset === null}
                    onClick={() => queue.data?.nextOffset != null && setOffset(queue.data.nextOffset)}
                  >
                    Next
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </section>

      <nav aria-label="Operations workspaces">
        <ul className={dashboard.linkList}>
          <li>
            <Link href="/admin/approvals">Pending approvals</Link>
          </li>
          <li>
            <Link href="/admin/actions/review">Post-action review</Link>
          </li>
          <li>
            <Link href="/admin/operations/refunds">Refunds</Link>
          </li>
          <li>
            <Link href="/admin/operations/payouts">Payouts</Link>
          </li>
          <li>
            <Link href="/admin/operations/disputes">Disputes</Link>
          </li>
          <li>
            <Link href="/admin/operations/support">Support</Link>
          </li>
          <li>
            <Link href="/admin/operations/safety">Safety</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
