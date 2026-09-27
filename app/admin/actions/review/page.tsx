'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, ErrorState, Input, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import type { PendingReviewDto } from '@/lib/types/admin-rbac';
import styles from '../../admin.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorBody;
}

function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (res.status === 204) return { ok: true };
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data as T } : { ok: false, error: json as ApiErrorBody };
}

function mutateHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() };
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

type PageStatus = 'loading' | 'error' | 'ready';

/**
 * Spec 009 §3.2/AC-3/§5, `app/admin/actions/review` — emergency-bypassed actions awaiting the
 * mandatory post-action review (`GET /admin/actions/pending-review`). Distinct from the normal
 * approvals queue (§5 UI states: "surfaced distinctly ... cannot be dismissed without recording a
 * review") — every row here already executed; recording a review is the only way it leaves this
 * list.
 */
export default function AdminPostActionReviewPage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [items, setItems] = useState<PendingReviewDto[]>([]);
  const [notesById, setNotesById] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowPending, setRowPending] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const load = useCallback(async () => {
    setPageStatus('loading');
    setPageError(null);
    const res = await apiFetch<PendingReviewDto[]>('/api/v1/admin/actions/pending-review');
    if (!res.ok) {
      setPageStatus('error');
      setPageError(res.error?.message ?? "Couldn't load pending post-action reviews.");
      return;
    }
    setItems(res.data ?? []);
    setPageStatus('ready');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleReview(id: string) {
    setRowError(null);
    const notes = (notesById[id] ?? '').trim();
    if (!notes) {
      setRowError('Review notes are required before this can be closed.');
      return;
    }
    setRowPending(id);
    const res = await apiFetch(`/api/v1/admin/actions/${id}/post-action-review`, {
      method: 'POST',
      headers: mutateHeaders(),
      body: JSON.stringify({ notes }),
    });
    setRowPending(null);
    if (!res.ok) {
      setRowError(res.error?.message ?? "Couldn't record that review.");
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== id));
    setAnnouncement('Post-action review recorded.');
  }

  if (pageStatus === 'loading') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>Post-action review</h1>
        <Card>
          <Skeleton lines={4} />
        </Card>
      </main>
    );
  }

  if (pageStatus === 'error') {
    return (
      <main className={styles.page} data-density="dense">
        <h1 className={styles.title}>Post-action review</h1>
        <ErrorState description={pageError ?? undefined} onRetry={load} />
      </main>
    );
  }

  const columns: TableColumn<PendingReviewDto>[] = [
    { key: 'resource', header: 'Resource', render: (row) => `${row.resource}.${row.actionType}` },
    { key: 'bypass', header: 'Bypass', render: () => <Badge tone="error">emergency bypass</Badge> },
    { key: 'target', header: 'Target', render: (row) => row.targetSummary },
    { key: 'reason', header: 'Reason', render: (row) => row.reason },
    { key: 'executedAt', header: 'Executed', render: (row) => formatDate(row.executedAt) },
    {
      key: 'review',
      header: 'Review',
      render: (row) => (
        <div className={styles.actions}>
          <Input
            aria-label={`Review notes for ${row.id}`}
            placeholder="Review notes (required)"
            value={notesById[row.id] ?? ''}
            onChange={(e) => setNotesById((prev) => ({ ...prev, [row.id]: e.target.value }))}
          />
          <Button variant="primary" size="sm" loading={rowPending === row.id} onClick={() => handleReview(row.id)}>
            Close review
          </Button>
        </div>
      ),
    },
  ];

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>Post-action review</h1>

      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>

      <section aria-labelledby="review-heading" className={styles.section}>
        <h2 id="review-heading" className={styles.sectionTitle}>
          Awaiting mandatory review
        </h2>
        <p className={styles.sectionDescription}>
          Every row here already executed via emergency bypass. Recording a review is the only way it leaves this list.
        </p>

        {rowError ? (
          <Alert tone="error" title="Something went wrong">
            {rowError}
          </Alert>
        ) : null}

        <Table
          columns={columns}
          rows={items}
          caption="Emergency-bypassed actions awaiting post-action review"
          emptyMessage="No reviews pending."
        />
      </section>
    </main>
  );
}
