'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorState, Skeleton, Table } from '@/components';
import type { TableColumn } from '@/components';
import { useLocale } from '@/app/_components/LocaleProvider';
import { formatDateTime } from '@/lib/i18n/format';
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

/**
 * Spec 008 — Security Sessions & Privacy Center. One route surfacing every control this spec
 * owns: active sessions (view/log out one/log out all others), the Security Center's MFA on/off
 * toggle (enrollment stays spec 005's job), data export (request/poll/download), and account
 * deletion (request with a grace period/cancel). Per CLAUDE.md's single-brand-placement rule,
 * this page carries no header/logo of its own — the global AppHeader already provides one.
 */
export default function PrivacySecurityPage() {
  const { locale, t, errorText } = useLocale();
  // Spec 042 X-11: the shared formatter, in the reader's locale.
  const formatDate = (iso: string) => formatDateTime(iso, locale);
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
      setPageError(errorText(sessionsRes.error?.code, sessionsRes.error?.message, t('privacy.loadFailed')));
      return;
    }

    setSessions(sessionsRes.data ?? []);
    if (mfaRes.ok) setMfaEnabledState(mfaRes.data!.mfaEnabled);
    if (deletionRes.ok) setDeletion(deletionRes.data!);
    setPageStatus('ready');
  }, [errorText, t]);

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
      setSessionsError(errorText(res.error?.code, res.error?.message, t('privacy.logoutOneFailed')));
      return;
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setAnnouncement(t('privacy.loggedOutOne'));
  }

  async function handleLogoutAllConfirmed() {
    setSessionsError(null);
    setLogoutAllPending(true);
    const res = await mutateWithStepUp<void>('/api/v1/users/me/sessions', 'DELETE', 'logout_all_other_devices');
    setLogoutAllPending(false);
    setLogoutAllOpen(false);
    if (!res.ok) {
      setSessionsError(errorText(res.error?.code, res.error?.message, t('privacy.logoutAllFailed')));
      return;
    }
    setSessions((prev) => prev.filter((s) => s.isCurrent));
    setAnnouncement(t('privacy.loggedOutAll'));
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
      setMfaError(errorText(res.error?.code, res.error?.message, t('privacy.mfaFailed')));
      return;
    }
    setMfaEnabledState(res.data!.mfaEnabled);
    setAnnouncement(res.data!.mfaEnabled ? t('privacy.mfaEnabled') : t('privacy.mfaDisabled'));
  }

  // --- Data export -----------------------------------------------------------

  const pollExport = useCallback((id: string) => {
    async function tick() {
      const res = await apiFetch<{ status: DataExportStatus; downloadUrl?: string }>(`/api/v1/users/me/data-export/${id}`);
      if (!res.ok) {
        setExportError(errorText(res.error?.code, res.error?.message, t('privacy.exportCheckFailed')));
        return;
      }
      setExportStatus(res.data!.status);
      if (res.data!.status === 'ready') {
        setDownloadUrl(res.data!.downloadUrl ?? null);
        setAnnouncement(t('privacy.exportReadyAnnounce'));
        return;
      }
      if (res.data!.status === 'failed') {
        setExportError(t('privacy.exportGenerateFailed'));
        return;
      }
      pollTimer.current = setTimeout(tick, 4000);
    }
    tick();
  }, [errorText, t]);

  async function handleRequestExport() {
    setExportError(null);
    setExportRequesting(true);
    const res = await mutateWithStepUp<{ exportRequestId: string }>('/api/v1/users/me/data-export', 'POST', 'request_data_export');
    setExportRequesting(false);
    if (!res.ok) {
      setExportError(errorText(res.error?.code, res.error?.message, t('privacy.exportStartFailed')));
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
      setDeletionError(errorText(res.error?.code, res.error?.message, t('privacy.deletionFailed')));
      return;
    }
    setDeletion({ lifecycleStatus: 'deletion_pending', deletionGraceEndsAt: res.data!.gracePeriodEndsAt });
    setAnnouncement(t('privacy.deletionRequested', { date: formatDate(res.data!.gracePeriodEndsAt) }));
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
      setDeletionError(errorText(res.error?.code, res.error?.message, t('privacy.cancelFailed')));
      return;
    }
    setDeletion({ lifecycleStatus: 'active', deletionGraceEndsAt: null });
    setAnnouncement(t('privacy.deletionCancelled'));
  }

  // --- Render -----------------------------------------------------------

  if (pageStatus === 'loading') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>{t('privacy.title')}</h1>
        <Card>
          <Skeleton lines={4} />
        </Card>
      </main>
    );
  }

  if (pageStatus === 'error') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>{t('privacy.title')}</h1>
        <ErrorState description={pageError ?? undefined} onRetry={loadAll} />
      </main>
    );
  }

  const columns: TableColumn<SessionSummaryDto>[] = [
    {
      key: 'device',
      header: t('privacy.device'),
      render: (row) => (
        <span className={styles.deviceCell}>
          {row.deviceLabel ?? t('privacy.unknownDevice')}
          {row.isCurrent ? (
            <Badge tone="brand" size="sm" icon={null}>
              {t('privacy.thisDevice')}
            </Badge>
          ) : null}
        </span>
      ),
    },
    { key: 'location', header: t('privacy.location'), render: (row) => row.approxLocation ?? t('privacy.unknown') },
    { key: 'lastActiveAt', header: t('privacy.lastActive'), render: (row) => formatDate(row.lastActiveAt) },
    {
      key: 'actions',
      header: t('privacy.actions'),
      align: 'end',
      render: (row) =>
        row.isCurrent ? null : (
          <Button
            variant="secondary"
            size="sm"
            loading={sessionPending === row.id}
            onClick={() => handleLogoutSingle(row.id)}
            aria-label={t('privacy.logOutDevice', { device: row.deviceLabel ?? t('privacy.deviceFallback') })}
          >
            {t('privacy.logOut')}
          </Button>
        ),
    },
  ];

  const otherSessionsCount = sessions.filter((s) => !s.isCurrent).length;

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>{t('privacy.title')}</h1>

      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>

      <section aria-labelledby="sessions-heading" className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 id="sessions-heading" className={styles.sectionTitle}>
            {t('privacy.sessionsTitle')}
          </h2>
          <Button variant="secondary" disabled={otherSessionsCount === 0} onClick={() => setLogoutAllOpen(true)}>
            {t('privacy.logOutAll')}
          </Button>
        </div>

        {sessionsError ? (
          <Alert tone="error" title={t('common.somethingWentWrong')}>
            {sessionsError}
          </Alert>
        ) : null}

        <Table
          columns={columns}
          rows={sessions}
          caption={t('privacy.sessionsCaption')}
          emptyMessage={t('privacy.noSessions')}
        />
      </section>

      <ConfirmDialog
        open={logoutAllOpen}
        title={t('privacy.logOutAllTitle')}
        description={t('privacy.logOutAllDescription')}
        confirmLabel={t('privacy.logOutOthers')}
        tone="danger"
        pending={logoutAllPending}
        onConfirm={handleLogoutAllConfirmed}
        onCancel={() => setLogoutAllOpen(false)}
      />

      <section aria-labelledby="mfa-heading" className={styles.section}>
        <h2 id="mfa-heading" className={styles.sectionTitle}>
          {t('privacy.mfaTitle')}
        </h2>
        {mfaError ? (
          <Alert tone="error" title={t('common.somethingWentWrong')}>
            {mfaError}
          </Alert>
        ) : null}
        <p className={styles.sectionDescription}>
          {mfaEnabled === null ? t('privacy.mfaUnknown') : mfaEnabled ? t('privacy.mfaOn') : t('privacy.mfaOff')}
        </p>
        <Button
          variant={mfaEnabled ? 'secondary' : 'primary'}
          loading={mfaPending}
          disabled={mfaEnabled === null}
          onClick={() => handleMfaToggle(!mfaEnabled)}
        >
          {mfaEnabled ? t('privacy.disableMfa') : t('privacy.enableMfa')}
        </Button>
      </section>

      <section aria-labelledby="export-heading" className={styles.section}>
        <h2 id="export-heading" className={styles.sectionTitle}>
          {t('privacy.exportTitle')}
        </h2>
        {exportError ? (
          <Alert tone="error" title={t('common.somethingWentWrong')}>
            {exportError}
          </Alert>
        ) : null}

        {exportStatus === 'idle' || exportStatus === 'failed' ? (
          <Button variant="secondary" loading={exportRequesting} onClick={handleRequestExport}>
            {t('privacy.requestExport')}
          </Button>
        ) : null}

        {exportStatus === 'pending' || exportStatus === 'processing' ? (
          <p role="status" className={styles.sectionDescription}>
            {t('privacy.preparing')}
          </p>
        ) : null}

        {exportStatus === 'ready' && downloadUrl ? (
          <Alert tone="success" title={t('privacy.exportReady')}>
            <a href={downloadUrl} className={styles.downloadLink}>
              {t('privacy.download')}
            </a>
          </Alert>
        ) : null}
      </section>

      <section aria-labelledby="deletion-heading" className={styles.section}>
        <h2 id="deletion-heading" className={styles.sectionTitle}>
          {t('privacy.deleteTitle')}
        </h2>
        {deletionError ? (
          <Alert tone="error" title={t('common.somethingWentWrong')}>
            {deletionError}
          </Alert>
        ) : null}

        {deletion.lifecycleStatus === 'deletion_pending' && deletion.deletionGraceEndsAt ? (
          <Alert tone="warning" title={t('privacy.pendingTitle')}>
            {t('privacy.pendingText', { date: formatDate(deletion.deletionGraceEndsAt) })}
            <div style={{ marginTop: 'var(--space-3)' }}>
              <Button variant="secondary" loading={cancelPending} onClick={handleCancelDeletion}>
                {t('privacy.cancelDeletion')}
              </Button>
            </div>
          </Alert>
        ) : (
          <Button variant="danger" onClick={() => setDeletionConfirmOpen(true)}>
            {t('privacy.deleteAccount')}
          </Button>
        )}
      </section>

      <ConfirmDialog
        open={deletionConfirmOpen}
        title={t('privacy.confirmTitle')}
        description={t('privacy.confirmDescription')}
        confirmLabel={t('privacy.deleteAccount')}
        tone="danger"
        pending={deletionPending}
        onConfirm={handleDeletionConfirmed}
        onCancel={() => setDeletionConfirmOpen(false)}
      />
    </main>
  );
}
