'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorState, Input, Skeleton, Switch, Table } from '@/components';
import type { TableColumn } from '@/components';
import type { FeatureFlagDto, FlagEnvironment, UpdateFeatureFlagRequest } from '@/lib/types/feature-flags';
import styles from '../../admin.module.css';

interface ApiErrorBody {
  code?: string;
  message?: string;
}

type PageStatus = 'loading' | 'forbidden' | 'error' | 'ready';

interface PendingChange {
  flag: FeatureFlagDto;
  enabled: boolean;
}

function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

const ENVIRONMENT_LABEL: Record<FlagEnvironment, string> = {
  development: 'Development',
  staging: 'Staging',
  production: 'Production',
};

function toggleErrorMessage(error: ApiErrorBody): string {
  switch (error.code) {
    case 'FORBIDDEN':
      return "You don't have permission to change this flag.";
    case 'CONFLICT':
      return 'Someone else changed this flag. The list has been refreshed — review it and try again.';
    case 'FLAG_ENVIRONMENT_MISMATCH':
      return 'This page is for a different environment than the one you are signed in to. Reload and try again.';
    case 'VALIDATION_ERROR':
      return 'A reason is required (up to 500 characters).';
    default:
      return error.message ?? "The flag couldn't be changed.";
  }
}

/**
 * Spec 041 §5 — `/admin/settings/feature-flags`. Lists the running environment's flags the caller
 * may see and toggles one per confirmed request. Authorization is decided server-side (spec 009):
 * developer flags simply never arrive for a non-Super-Admin (AC-2), and a `403` list shows a
 * no-access state. There is no optimistic toggle — a Switch changes only after the server confirms.
 */
export default function AdminFeatureFlagsPage() {
  const [status, setStatus] = useState<PageStatus>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [flags, setFlags] = useState<FeatureFlagDto[]>([]);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setLoadError(null);
    try {
      const res = await fetch('/api/v1/admin/feature-flags', { credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (res.status === 403) return setStatus('forbidden');
      if (!res.ok) {
        setLoadError((json as ApiErrorBody).message ?? null);
        return setStatus('error');
      }
      setFlags((json as { data: FeatureFlagDto[] }).data);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function requestChange(flag: FeatureFlagDto, enabled: boolean) {
    setToggleError(null);
    setReason('');
    setConfirming(false);
    setPending({ flag, enabled });
  }

  function cancelChange() {
    setPending(null);
    setConfirming(false);
  }

  /** Step 1 — the inline panel: a reason is required before the confirmation dialog opens. */
  function reviewChange() {
    if (reason.trim().length === 0) {
      setToggleError(toggleErrorMessage({ code: 'VALIDATION_ERROR' }));
      return;
    }
    setToggleError(null);
    setConfirming(true);
  }

  /** Step 2 — the confirmed request. */
  async function confirmChange() {
    if (!pending) return;
    const trimmed = reason.trim();
    setSaving(true);
    const body: UpdateFeatureFlagRequest = {
      environment: pending.flag.environment,
      enabled: pending.enabled,
      expectedVersion: pending.flag.version,
      reason: trimmed,
    };
    try {
      const res = await fetch(`/api/v1/admin/feature-flags/${encodeURIComponent(pending.flag.key)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const error = json as ApiErrorBody;
        setToggleError(toggleErrorMessage(error));
        cancelChange();
        if (error.code === 'CONFLICT') await load();
        return;
      }
      const updated = (json as { data: FeatureFlagDto }).data;
      setFlags((current) => current.map((f) => (f.key === updated.key ? updated : f)));
      cancelChange();
    } catch {
      setToggleError(toggleErrorMessage({}));
      cancelChange();
    } finally {
      setSaving(false);
    }
  }

  const environment = flags[0]?.environment ?? null;

  const columns: TableColumn<FeatureFlagDto>[] = [
    {
      key: 'flag',
      header: 'Flag',
      render: (flag) => (
        <div>
          <strong>{flag.key}</strong>
          <div className={styles.sectionDescription}>{flag.description}</div>
          {flag.overriddenBy ? (
            <div className={styles.sectionDescription}>
              Overridden by <code>{flag.overriddenBy}</code> — the toggle has no effect until it is removed.
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Type',
      render: (flag) => (
        <span className={styles.actions}>
          {flag.controlledBy === 'developer' ? <Badge tone="warning">Technical</Badge> : <Badge tone="neutral">Business</Badge>}
          {flag.isKillSwitch ? <Badge tone="error">Kill switch</Badge> : null}
        </span>
      ),
    },
    {
      key: 'enabled',
      header: 'Enabled',
      align: 'end',
      render: (flag) => (
        <Switch
          label={<span className={styles.visuallyHidden}>{`${flag.key} ${flag.enabled ? 'on' : 'off'}`}</span>}
          checked={flag.enabled}
          disabled={flag.overriddenBy !== null || saving || pending !== null}
          onChange={(next) => requestChange(flag, next)}
        />
      ),
    },
  ];

  let body: ReactNode;
  if (status === 'loading') {
    body = (
      <Card>
        <Skeleton lines={6} />
      </Card>
    );
  } else if (status === 'forbidden') {
    body = <Alert tone="info">You don&apos;t have access to feature flags.</Alert>;
  } else if (status === 'error') {
    body = <ErrorState description={loadError ?? undefined} onRetry={load} />;
  } else if (flags.length === 0) {
    body = <p className={styles.sectionDescription}>No feature flags are available to you.</p>;
  } else {
    body = <Table caption="Feature flags" density="dense" columns={columns} rows={flags} />;
  }

  const production = pending?.flag.environment === 'production';

  return (
    <main className={styles.page} data-density="dense">
      <h1 className={styles.title}>Feature flags</h1>
      {environment ? (
        <p className={styles.sectionDescription}>
          Environment: <strong>{ENVIRONMENT_LABEL[environment]}</strong> — changes apply to this environment only, without a deploy.
        </p>
      ) : null}
      {toggleError ? (
        <Alert tone="error" onDismiss={() => setToggleError(null)}>
          {toggleError}
        </Alert>
      ) : null}
      {body}
      {pending ? (
        <section aria-labelledby="flag-change-heading" className={styles.section}>
          <Card>
            <div className={styles.section}>
              <h2 id="flag-change-heading" className={styles.sectionTitle}>
                {`Turn ${pending.flag.key} ${pending.enabled ? 'on' : 'off'}`}
              </h2>
              {production ? (
                <Alert tone="warning" title="Production change">
                  This changes the live production platform immediately for every new request.
                </Alert>
              ) : null}
              <label className={styles.formField}>
                <span className={styles.sectionDescription}>Reason (required)</span>
                <Input fullWidth maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className={styles.actions}>
                <Button variant="primary" onClick={reviewChange} disabled={saving}>
                  Review change
                </Button>
                <Button variant="ghost" onClick={cancelChange} disabled={saving}>
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        </section>
      ) : null}
      <ConfirmDialog
        open={pending !== null && confirming}
        title={pending ? `Turn ${pending.flag.key} ${pending.enabled ? 'on' : 'off'}?` : ''}
        tone={production ? 'danger' : 'primary'}
        confirmLabel={pending?.enabled ? 'Turn on' : 'Turn off'}
        pending={saving}
        onCancel={() => setConfirming(false)}
        onConfirm={confirmChange}
        description={
          pending
            ? `${ENVIRONMENT_LABEL[pending.flag.environment]} only${production ? ' — this is the live production platform' : ''}. Reason: ${reason.trim()}`
            : undefined
        }
      />
    </main>
  );
}
