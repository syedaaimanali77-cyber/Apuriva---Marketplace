'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorState, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import type { DataExportStatus, SessionSummaryDto } from '@/lib/types/privacy';
import styles from './privacy-security.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorBody;
}

/** Same CSRF-cookie-echo pattern as app/account/_components/AccountMenu.tsx and
 * app/(auth)/login/page.tsx — the CSRF cookie (spec 005 §3) is deliberately not httpOnly. */
function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (res.status === 204) return { ok: true };
  const json = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: json.data as T } : { ok: false, error: json as ApiErrorBody };
}

function mutateHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie(), ...extra };
}

/** Spec 005 AC-6 step-up flow: mint a token for `action`, then echo it back via
 * `X-Step-Up-Token` (lib/auth/step-up.ts) on the sensitive request itself. */
async function obtainStepUpToken(action: string): Promise<string | null> {
  const res = await apiFetch<{ stepUpToken: string }>('/api/v1/auth/step-up', {
    method: 'POST',
    headers: mutateHeaders(),
    body: JSON.stringify({ action }),
  });
  return res.ok ? res.data!.stepUpToken : null;
}

async function mutateWithStepUp<T>(
  url: string,
  method: string,
  action: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const stepUpToken = await obtainStepUpToken(action);
  if (!stepUpToken) {
    return { ok: false, error: { code: 'STEP_UP_REQUIRED', message: 'Could not verify it was really you. Try again.' } };
  }
  return apiFetch<T>(url, {
    method,
    headers: mutateHeaders({ 'x-step-up-token': stepUpToken }),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

type PageStatus = 'loading' | 'error' | 'ready';

interface DeletionState {
  lifecycleStatus: string;
  deletionGraceEndsAt: string | null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

/**
 * Spec 008 — Security Sessions & Privacy Center. One route surfacing every control this spec
 * owns: active sessions (view/log out one/log out all others), the Security Center's MFA on/off
 * toggle (enrollment stays spec 005's job), data export (request/poll/download), and account
 * deletion (request with a grace period/cancel). Per CLAUDE.md's single-brand-placement rule,
 * this page carries no header/logo of its own — the global AppHeader already provides one.
 */
export default function PrivacySecurityPage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const [sessions, setSessions] = useState<SessionSummaryDto[]>([]);
  const [sessionPending, setSessionPending] = useState<string | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [logoutAllOpen, setLogoutAllOpen] = useState(false);
  const [logoutAllPending, setLogoutAllPending] = useState(false);

  const [mfaEnabled, setMfaEnabledState] = useState<boolean | null>(null);
  const [mfaPending, setMfaPending] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);

  const [exportStatus, setExportStatus] = useState<DataExportStatus | 'idle'>('idle');
  const [exportId, setExportId] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportRequesting, setExportRequesting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [deletion, setDeletion] = useState<DeletionState>({ lifecycleStatus: 'active', deletionGraceEndsAt: null });
  const [deletionConfirmOpen, setDeletionConfirmOpen] = useState(false);
  const [deletionPending, setDeletionPending] = useState(false);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState(false);

  const loadAll = useCallback(async () => {
    setPageStatus('loading');
    setPageError(null);
    const [sessionsRes, mfaRes, deletionRes] = await Promise.all([
      apiFetch<SessionSummaryDto[]>('/api/v1/users/me/sessions'),
      apiFetch<{ mfaEnabled: boolean }>('/api/v1/users/me/mfa'),
      apiFetch<DeletionState>('/api/v1/users/me/deletion'),
    ]);

    if (!sessionsRes.ok) {
      setPageStatus('error');
      setPageError(sessionsRes.error?.message ?? "Couldn't load your Security & Privacy Center.");
      return;
    }

    setSessions(sessionsRes.data ?? []);
    if (mfaRes.ok) setMfaEnabledState(mfaRes.data!.mfaEnabled);
    if (deletionRes.ok) setDeletion(deletionRes.data!);
    setPageStatus('ready');
  }, []);

  useEffect(() => {
    loadAll();
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [loadAll]);

  // --- Sessions -----------------------------------------------------------

  async function handleLogoutSingle(id: string) {
    setSessionsError(null);
    setSessionPending(id);
    const res = await apiFetch<void>(`/api/v1/users/me/sessions/${id}`, {
      method: 'DELETE',
      headers: mutateHeaders(),
    });
    setSessionPending(null);
    if (!res.ok) {
      setSessionsError(res.error?.message ?? "Couldn't log out that device. Try again.");
      return;
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setAnnouncement('Device logged out.');
  }

  async function handleLogoutAllConfirmed() {
    setSessionsError(null);
    setLogoutAllPending(true);
    const res = await mutateWithStepUp<void>('/api/v1/users/me/sessions', 'DELETE', 'logout_all_other_devices');
    setLogoutAllPending(false);
    setLogoutAllOpen(false);
    if (!res.ok) {
      setSessionsError(res.error?.message ?? "Couldn't log out other devices. Try again.");
      return;
    }
    setSessions((prev) => prev.filter((s) => s.isCurrent));
    setAnnouncement('Logged out of all other devices.');
  }

  // --- MFA -----------------------------------------------------------------

  async function handleMfaToggle(nextEnabled: boolean) {
    setMfaError(null);
    setMfaPending(true);
    const res = await mutateWithStepUp<{ mfaEnabled: boolean }>('/api/v1/users/me/mfa', 'PATCH', 'toggle_mfa', {
      enabled: nextEnabled,
    });
    setMfaPending(false);
    if (!res.ok) {
      setMfaError(res.error?.message ?? "Couldn't update MFA. Try again.");
      return;
    }
    setMfaEnabledState(res.data!.mfaEnabled);
    setAnnouncement(res.data!.mfaEnabled ? 'MFA enabled.' : 'MFA disabled.');
  }

  // --- Data export -----------------------------------------------------------

  const pollExport = useCallback((id: string) => {
    async function tick() {
      const res = await apiFetch<{ status: DataExportStatus; downloadUrl?: string }>(`/api/v1/users/me/data-export/${id}`);
      if (!res.ok) {
        setExportError(res.error?.message ?? "Couldn't check your export status.");
        return;
      }
      setExportStatus(res.data!.status);
      if (res.data!.status === 'ready') {
        setDownloadUrl(res.data!.downloadUrl ?? null);
        setAnnouncement('Your data export is ready to download.');
        return;
      }
      if (res.data!.status === 'failed') {
        setExportError('Your export failed to generate. Try requesting it again.');
        return;
      }
      pollTimer.current = setTimeout(tick, 4000);
    }
    tick();
  }, []);

  async function handleRequestExport() {
    setExportError(null);
    setExportRequesting(true);
    const res = await mutateWithStepUp<{ exportRequestId: string }>('/api/v1/users/me/data-export', 'POST', 'request_data_export');
    setExportRequesting(false);
    if (!res.ok) {
      setExportError(res.error?.message ?? "Couldn't start your export. Try again.");
      return;
    }
    setExportId(res.data!.exportRequestId);
    setExportStatus('pending');
    setDownloadUrl(null);
    pollExport(res.data!.exportRequestId);
  }

  // --- Deletion -----------------------------------------------------------

  async function handleDeletionConfirmed() {
    setDeletionError(null);
    setDeletionPending(true);
    const res = await mutateWithStepUp<{ gracePeriodEndsAt: string }>('/api/v1/users/me/deletion', 'POST', 'request_account_deletion');
    setDeletionPending(false);
    setDeletionConfirmOpen(false);
    if (!res.ok) {
      if (res.error?.code === 'ACTIVE_BOOKING_BLOCKS_DELETION') {
        setDeletionError(res.error.message);
        return;
      }
      setDeletionError(res.error?.message ?? "Couldn't start account deletion. Try again.");
      return;
    }
    setDeletion({ lifecycleStatus: 'deletion_pending', deletionGraceEndsAt: res.data!.gracePeriodEndsAt });
    setAnnouncement(`Account deletion requested. You can cancel until ${formatDate(res.data!.gracePeriodEndsAt)}.`);
  }

  async function handleCancelDeletion() {
    setDeletionError(null);
    setCancelPending(true);
    const res = await apiFetch<{ lifecycleStatus: 'active' }>('/api/v1/users/me/deletion/cancel', {
      method: 'POST',
      headers: mutateHeaders(),
    });
    setCancelPending(false);
    if (!res.ok) {
      setDeletionError(res.error?.message ?? "Couldn't cancel deletion. Try again.");
      return;
    }
    setDeletion({ lifecycleStatus: 'active', deletionGraceEndsAt: null });
    setAnnouncement('Account deletion cancelled.');
  }

  // --- Render -----------------------------------------------------------

  if (pageStatus === 'loading') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Security &amp; Privacy Center</h1>
        <Card>
          <Skeleton lines={4} />
        </Card>
      </main>
    );
  }

  if (pageStatus === 'error') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Security &amp; Privacy Center</h1>
        <ErrorState description={pageError ?? undefined} onRetry={loadAll} />
      </main>
    );
  }

  const columns: TableColumn<SessionSummaryDto>[] = [
    {
      key: 'device',
      header: 'Device',
      render: (row) => (
        <span className={styles.deviceCell}>
          {row.deviceLabel ?? 'Unknown device'}
          {row.isCurrent ? (
            <Badge tone="brand" size="sm" icon={null}>
              This device
            </Badge>
          ) : null}
        </span>
      ),
    },
    { key: 'location', header: 'Location', render: (row) => row.approxLocation ?? 'Unknown' },
    { key: 'lastActiveAt', header: 'Last active', render: (row) => formatDate(row.lastActiveAt) },
    {
      key: 'actions',
      header: 'Actions',
      align: 'end',
      render: (row) =>
        row.isCurrent ? null : (
          <Button
            variant="secondary"
            size="sm"
            loading={sessionPending === row.id}
            onClick={() => handleLogoutSingle(row.id)}
            aria-label={`Log out ${row.deviceLabel ?? 'device'}`}
          >
            Log out
          </Button>
        ),
    },
  ];

  const otherSessionsCount = sessions.filter((s) => !s.isCurrent).length;

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Security &amp; Privacy Center</h1>

      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>

      <section aria-labelledby="sessions-heading" className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 id="sessions-heading" className={styles.sectionTitle}>
            Active sessions
          </h2>
          <Button variant="secondary" disabled={otherSessionsCount === 0} onClick={() => setLogoutAllOpen(true)}>
            Log out all other devices
          </Button>
        </div>

        {sessionsError ? (
          <Alert tone="error" title="Something went wrong">
            {sessionsError}
          </Alert>
        ) : null}

        <Table
          columns={columns}
          rows={sessions}
          caption="Your active sessions"
          emptyMessage="No active sessions."
        />
      </section>

      <ConfirmDialog
        open={logoutAllOpen}
        title="Log out all other devices?"
        description="Every session except this one will be signed out immediately. You'll stay signed in here."
        confirmLabel="Log out other devices"
        tone="danger"
        pending={logoutAllPending}
        onConfirm={handleLogoutAllConfirmed}
        onCancel={() => setLogoutAllOpen(false)}
      />

      <section aria-labelledby="mfa-heading" className={styles.section}>
        <h2 id="mfa-heading" className={styles.sectionTitle}>
          Two-factor authentication
        </h2>
        {mfaError ? (
          <Alert tone="error" title="Something went wrong">
            {mfaError}
          </Alert>
        ) : null}
        <p className={styles.sectionDescription}>
          {mfaEnabled === null
            ? "We couldn't determine your current MFA status."
            : mfaEnabled
              ? 'Two-factor authentication is currently on for your account.'
              : 'Two-factor authentication is currently off for your account.'}
        </p>
        <Button
          variant={mfaEnabled ? 'secondary' : 'primary'}
          loading={mfaPending}
          disabled={mfaEnabled === null}
          onClick={() => handleMfaToggle(!mfaEnabled)}
        >
          {mfaEnabled ? 'Disable MFA' : 'Enable MFA'}
        </Button>
      </section>

      <section aria-labelledby="export-heading" className={styles.section}>
        <h2 id="export-heading" className={styles.sectionTitle}>
          Export your data
        </h2>
        {exportError ? (
          <Alert tone="error" title="Something went wrong">
            {exportError}
          </Alert>
        ) : null}

        {exportStatus === 'idle' || exportStatus === 'failed' ? (
          <Button variant="secondary" loading={exportRequesting} onClick={handleRequestExport}>
            Request my data export
          </Button>
        ) : null}

        {exportStatus === 'pending' || exportStatus === 'processing' ? (
          <p role="status" className={styles.sectionDescription}>
            Preparing your export — this may take a few minutes. You can leave this page; it'll keep going.
          </p>
        ) : null}

        {exportStatus === 'ready' && downloadUrl ? (
          <Alert tone="success" title="Your export is ready">
            <a href={downloadUrl} className={styles.downloadLink}>
              Download my data
            </a>
          </Alert>
        ) : null}
      </section>

      <section aria-labelledby="deletion-heading" className={styles.section}>
        <h2 id="deletion-heading" className={styles.sectionTitle}>
          Delete your account
        </h2>
        {deletionError ? (
          <Alert tone="error" title="Something went wrong">
            {deletionError}
          </Alert>
        ) : null}

        {deletion.lifecycleStatus === 'deletion_pending' && deletion.deletionGraceEndsAt ? (
          <Alert tone="warning" title="Account deletion pending">
            Your account will be deleted on {formatDate(deletion.deletionGraceEndsAt)}. You can cancel until then.
            <div style={{ marginTop: 'var(--space-3)' }}>
              <Button variant="secondary" loading={cancelPending} onClick={handleCancelDeletion}>
                Cancel deletion
              </Button>
            </div>
          </Alert>
        ) : (
          <Button variant="danger" onClick={() => setDeletionConfirmOpen(true)}>
            Delete my account
          </Button>
        )}
      </section>

      <ConfirmDialog
        open={deletionConfirmOpen}
        title="Delete your account?"
        description="Your account will enter a grace period, then your personal data will be permanently anonymized. This can't be undone once that happens."
        confirmLabel="Delete my account"
        tone="danger"
        pending={deletionPending}
        onConfirm={handleDeletionConfirmed}
        onCancel={() => setDeletionConfirmOpen(false)}
      />
    </main>
  );
}
