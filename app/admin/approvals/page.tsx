'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, ErrorState, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import type { PendingApprovalDto, RiskTier } from '@/lib/types/admin-rbac';
import styles from '../admin.module.css';

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

function riskTone(riskTier: RiskTier): 'warning' | 'error' {
  return riskTier === 'critical' ? 'error' : 'warning';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

type PageStatus = 'loading' | 'error' | 'ready';

/**
 * Spec 009 §3/§5/§6, `app/admin/approvals` — every `Pending` `AdminAction` the caller is
 * authorized to decide (`GET /admin/approvals/pending`, scoped server-side to their role). Approve
 * and reject call straight through to the framework's eligibility checks (self-approval,
 * authorization, terminal-state) — this page surfaces whatever the backend actually decides, it
 * never pre-filters based on a client-side guess at who's allowed to act.
 */
export default function AdminApprovalsPage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<PendingApprovalDto[]>([]);
  const [rowError, setRowError] = useState<string | null>(null);
  const [rowPending, setRowPending] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const load = useCallback(async () => {
    setPageStatus('loading');
    setPageError(null);
    const res = await apiFetch<PendingApprovalDto[]>('/api/v1/admin/approvals/pending');
    if (!res.ok) {
      setPageStatus('error');
      setPageError(res.error?.message ?? "Couldn't load pending approvals.");
      return;
    }
    setApprovals(res.data ?? []);
    setPageStatus('ready');
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDecision(id: string, decision: 'approve' | 'reject') {
    setRowError(null);
    setRowPending(id);
    const res = await apiFetch(`/api/v1/admin/approvals/${id}/${decision}`, { method: 'POST', headers: mutateHeaders() });
    setRowPending(null);
    if (!res.ok) {
      setRowError(res.error?.message ?? `Couldn't ${decision} that action.`);
      return;
    }
    setApprovals((prev) => prev.filter((a) => a.id !== id));
    setAnnouncement(decision === 'approve' ? 'Action approved.' : 'Action rejected.');
  }

  if (pageStatus === 'loading') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Pending approvals</h1>
        <Card>
          <Skeleton lines={4} />
        </Card>
      </main>
    );
  }

  if (pageStatus === 'error') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Pending approvals</h1>
        <ErrorState description={pageError ?? undefined} onRetry={load} />
      </main>
    );
  }

  const columns: TableColumn<PendingApprovalDto>[] = [
    { key: 'resource', header: 'Resource', render: (row) => `${row.resource}.${row.actionType}` },
    { key: 'riskTier', header: 'Risk', render: (row) => <Badge tone={riskTone(row.riskTier)}>{row.riskTier}</Badge> },
    { key: 'target', header: 'Target', render: (row) => row.targetSummary },
    { key: 'reason', header: 'Reason', render: (row) => row.reason },
    { key: 'initiatedAt', header: 'Initiated', render: (row) => formatDate(row.initiatedAt) },
    {
      key: 'actions',
      header: 'Decision',
      align: 'end',
      render: (row) => (
        <div className={styles.actions}>
          <Button variant="primary" size="sm" loading={rowPending === row.id} onClick={() => handleDecision(row.id, 'approve')}>
            Approve
          </Button>
          <Button variant="danger" size="sm" loading={rowPending === row.id} onClick={() => handleDecision(row.id, 'reject')}>
            Reject
          </Button>
        </div>
      ),
    },
  ];

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Pending approvals</h1>

      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>

      <section aria-labelledby="approvals-heading" className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 id="approvals-heading" className={styles.sectionTitle}>
            Awaiting your decision
          </h2>
        </div>

        {rowError ? (
          <Alert tone="error" title="Something went wrong">
            {rowError}
          </Alert>
        ) : null}

        <Table
          columns={columns}
          rows={approvals}
          caption="High/critical-risk actions pending approval"
          emptyMessage="No approvals pending."
        />
      </section>
    </main>
  );
}
