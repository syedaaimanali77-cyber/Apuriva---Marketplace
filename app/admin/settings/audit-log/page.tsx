'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Input, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import type { AuditLogDto } from '@/lib/types/audit';
import type { PagedResponse } from '@/lib/types/api';
import styles from '../../admin.module.css';
import local from './audit-log.module.css';
import { buildAuditQuery, EMPTY_FILTERS, FILTER_FIELDS, formatJson, PAGE_SIZE, type AuditLogFilters } from './audit-log-view';

interface ApiErrorBody {
  code?: string;
  message?: string;
  errors?: { field: string; message: string }[];
  correlationId?: string;
}

type PageStatus = 'loading' | 'forbidden' | 'error' | 'ready';

function actorTone(actorType: AuditLogDto['actorType']): 'info' | 'neutral' | 'warning' {
  if (actorType === 'admin') return 'info';
  if (actorType === 'system') return 'warning';
  return 'neutral';
}

const COLUMNS: TableColumn<AuditLogDto>[] = [
  { key: 'createdAt', header: 'Time', render: (row) => new Date(row.createdAt).toLocaleString() },
  {
    key: 'actor',
    header: 'Actor',
    render: (row) => (
      <span>
        <Badge tone={actorTone(row.actorType)} icon={null} size="sm">
          {row.actorType}
        </Badge>{' '}
        {row.actorUserId ?? '—'}
      </span>
    ),
  },
  { key: 'actorRoles', header: 'Roles', render: (row) => (row.actorRoles.length > 0 ? row.actorRoles.join(', ') : '—') },
  { key: 'eventType', header: 'Event' },
  {
    key: 'target',
    header: 'Target',
    render: (row) => (row.targetType ? `${row.targetType}${row.targetId ? ` · ${row.targetId}` : ''}` : '—'),
  },
  { key: 'correlationId', header: 'Correlation id', render: (row) => row.correlationId ?? '—' },
];

/**
 * Spec 039 §5, `app/admin/settings/audit-log` — the append-only audit log, read-only.
 *
 * Every read goes through `GET /api/v1/admin/audit-logs[/{id}]`, which enforces `audit_logs/read`
 * and the caller's domain scope server-side (AC-4). This page never decides access itself: a `403`
 * shows the "no access" state, and a resource filter outside the caller's scope shows the server's
 * refusal while keeping every filter as typed. There is no edit or delete control anywhere.
 */
export default function AdminAuditLogPage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<ApiErrorBody | null>(null);
  const [draft, setDraft] = useState<AuditLogFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AuditLogFilters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<PagedResponse<AuditLogDto> | null>(null);
  const [scopeRefusal, setScopeRefusal] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditLogDto | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async (filters: AuditLogFilters, nextOffset: number) => {
    setPageStatus('loading');
    setPageError(null);
    setScopeRefusal(null);
    try {
      const res = await fetch(`/api/v1/admin/audit-logs?${buildAuditQuery(filters, nextOffset)}`, {
        credentials: 'same-origin',
      });
      const json = (await res.json().catch(() => ({}))) as ApiErrorBody & Partial<PagedResponse<AuditLogDto>>;
      if (!res.ok) {
        // A filtered 403 is a scope refusal of THAT query; an unfiltered one means no access at all.
        if (json.code === 'FORBIDDEN' && filters.resource.trim()) {
          setScopeRefusal(json.message ?? 'That resource is outside your audit-log scope.');
          setResult(null);
          setPageStatus('ready');
          return;
        }
        if (json.code === 'FORBIDDEN') {
          setPageStatus('forbidden');
          return;
        }
        setPageError(json);
        setPageStatus('error');
        return;
      }
      setResult(json as PagedResponse<AuditLogDto>);
      setPageStatus('ready');
    } catch {
      setPageError({ message: "Couldn't reach the server. Check your connection and try again." });
      setPageStatus('error');
    }
  }, []);

  useEffect(() => {
    load(applied, offset);
  }, [load, applied, offset]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSelected(null);
    setOffset(0);
    setApplied({ ...draft });
  };

  const onReset = () => {
    setDraft(EMPTY_FILTERS);
    setSelected(null);
    setOffset(0);
    setApplied(EMPTY_FILTERS);
  };

  const openDetail = async (row: AuditLogDto) => {
    setDetailError(null);
    setSelected(row);
    try {
      const res = await fetch(`/api/v1/admin/audit-logs/${encodeURIComponent(row.id)}`, { credentials: 'same-origin' });
      const json = (await res.json().catch(() => ({}))) as ApiErrorBody & { data?: AuditLogDto };
      if (!res.ok || !json.data) {
        setDetailError(json.message ?? "Couldn't load this entry.");
        return;
      }
      setSelected(json.data);
    } catch {
      setDetailError("Couldn't load this entry.");
    }
  };

  const heading = <h1 className={styles.title}>Audit log</h1>;

  if (pageStatus === 'forbidden') {
    return (
      <main className={styles.page} data-density="dense">
        {heading}
        <Alert tone="warning" title="You don't have access to the audit log">
          Reading the audit log needs the audit-log permission, and each role sees only its own domain.
        </Alert>
      </main>
    );
  }

  return (
    <main className={styles.page} data-density="dense">
      {heading}

      <Card>
        <form className={local.filters} onSubmit={onSubmit} aria-label="Filter audit entries">
          {FILTER_FIELDS.map(({ key, label, type }) => (
            <label key={key} className={local.field}>
              {label}
              <Input
                size="sm"
                type={type ?? 'text'}
                value={draft[key]}
                onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}
              />
            </label>
          ))}
          <div className={styles.actions}>
            <Button type="submit" size="sm">
              Apply filters
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onReset}>
              Clear
            </Button>
          </div>
        </form>
      </Card>

      {scopeRefusal && (
        <Alert tone="warning" title="Outside your scope">
          {scopeRefusal}
        </Alert>
      )}

      {pageStatus === 'loading' && (
        <Card>
          <Skeleton lines={8} />
        </Card>
      )}

      {pageStatus === 'error' && (
        <ErrorState
          description={pageError?.message ?? "Couldn't load the audit log."}
          traceId={pageError?.correlationId}
          onRetry={() => load(applied, offset)}
        />
      )}

      {pageStatus === 'ready' && result && result.data.length === 0 && (
        <EmptyState
          icon="search"
          title="No matching audit entries"
          description="Change or clear the filters to see more of the entries within your scope."
        />
      )}

      {pageStatus === 'ready' && result && result.data.length > 0 && (
        <section className={styles.section} aria-label="Audit entries">
          <Table
            caption="Audit entries, newest first"
            density="dense"
            columns={COLUMNS}
            rows={result.data}
            onRowClick={(row) => openDetail(row)}
          />
          <div className={local.pager}>
            <span>
              {result.page.offset + 1}–{result.page.offset + result.data.length} of {result.page.total}
            </span>
            <div className={styles.actions}>
              <Button
                size="sm"
                variant="secondary"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={result.page.nextOffset === null}
                onClick={() => result.page.nextOffset !== null && setOffset(result.page.nextOffset)}
              >
                Next
              </Button>
            </div>
          </div>
        </section>
      )}

      {selected && (
        <Card aria-label="Audit entry detail">
          <div className={local.detail}>
            <h2 className={styles.sectionTitle}>{selected.eventType}</h2>
            {detailError && (
              <Alert tone="error" title="Couldn't load this entry">
                {detailError}
              </Alert>
            )}
            <dl className={local.meta}>
              <dt>Time</dt>
              <dd>{new Date(selected.createdAt).toLocaleString()}</dd>
              <dt>Actor</dt>
              <dd>
                {selected.actorType} · {selected.actorUserId ?? '—'}
              </dd>
              <dt>Roles</dt>
              <dd>{selected.actorRoles.length > 0 ? selected.actorRoles.join(', ') : '—'}</dd>
              <dt>Resource / action</dt>
              <dd>
                {selected.resource} / {selected.action}
              </dd>
              <dt>Target</dt>
              <dd>{selected.targetType ? `${selected.targetType} · ${selected.targetId ?? '—'}` : '—'}</dd>
              <dt>Reason</dt>
              <dd>{selected.reason ?? '—'}</dd>
              <dt>Approval reference</dt>
              <dd>{selected.approvalRef ?? '—'}</dd>
              <dt>Emergency bypass</dt>
              <dd>{selected.isEmergencyBypass ? 'Yes' : 'No'}</dd>
              <dt>Correlation id</dt>
              <dd>{selected.correlationId ?? '— (no originating request)'}</dd>
            </dl>
            <div className={local.values}>
              <div>
                <h3 className={local.valueTitle}>Before</h3>
                <pre className={local.json}>{formatJson(selected.beforeValue)}</pre>
              </div>
              <div>
                <h3 className={local.valueTitle}>After</h3>
                <pre className={local.json}>{formatJson(selected.afterValue)}</pre>
              </div>
              <div>
                <h3 className={local.valueTitle}>Approval chain</h3>
                <pre className={local.json}>{formatJson(selected.approvalChain)}</pre>
              </div>
            </div>
          </div>
        </Card>
      )}
    </main>
  );
}
