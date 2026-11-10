'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Skeleton } from '@/components';
import { formatMinute, WeeklyScheduleEditor } from './_components/WeeklyScheduleEditor';
import type { OverrideDto, ServiceAreaDto, WeeklyScheduleDto, WeeklyScheduleEntry } from '@/lib/types/availability';
import styles from './schedule.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
  errors?: { field: string; message: string }[];
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: ApiErrorBody;
}

/** Same CSRF-cookie-echo pattern as app/account/addresses/page.tsx. */
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

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

type PageStatus = 'loading' | 'error' | 'ready';

/**
 * Spec 016 §5 — the provider's schedule and service-area screen, replacing the spec-014
 * `PlaceholderPage` that named this spec.
 *
 * Per CLAUDE.md's branding rule this page carries no logo/header of its own — the global
 * AppHeader already provides the page's one brand placement. Every visual comes from the existing
 * design system via `@/components` and `app/styles/apuriva-tokens.css`: no new primitive, no
 * hand-written colour or size, and no already-shipped screen redesigned.
 *
 * §5 states: Loading (Skeleton), Empty (no weekly entries → EmptyState prompt), Error
 * (`409 SLOT_OVERLAP` → Alert naming the conflict; `422` → per-field errors mapped onto the
 * editor's FormField slots, entered values preserved), Success (saved set reflected immediately).
 */
export default function ProviderSchedulePage() {
  const [pageStatus, setPageStatus] = useState<PageStatus>('loading');
  const [pageError, setPageError] = useState<string | null>(null);

  const [schedule, setSchedule] = useState<WeeklyScheduleDto | null>(null);
  const [entries, setEntries] = useState<WeeklyScheduleEntry[]>([]);
  const [overrides, setOverrides] = useState<OverrideDto[]>([]);
  const [serviceAreas, setServiceAreas] = useState<ServiceAreaDto[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPageStatus('loading');
    setPageError(null);

    const [scheduleRes, overridesRes, areasRes] = await Promise.all([
      apiFetch<WeeklyScheduleDto>('/api/v1/providers/me/availability/schedule'),
      apiFetch<OverrideDto[]>(`/api/v1/providers/me/availability/overrides?from=${today()}&to=${plusDays(60)}`),
      apiFetch<ServiceAreaDto[]>('/api/v1/providers/me/service-areas'),
    ]);

    if (!scheduleRes.ok || !scheduleRes.data) {
      setPageError(scheduleRes.error?.message ?? 'Could not load your schedule.');
      setPageStatus('error');
      return;
    }

    setSchedule(scheduleRes.data);
    setEntries(scheduleRes.data.entries);
    setOverrides(overridesRes.data ?? []);
    setServiceAreas(areasRes.data ?? []);
    setPageStatus('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSchedule() {
    if (!schedule) return;
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    setSavedMessage(null);

    const res = await apiFetch<WeeklyScheduleDto>('/api/v1/providers/me/availability/schedule', {
      method: 'PUT',
      headers: mutateHeaders(),
      body: JSON.stringify({ timezone: schedule.timezone, entries, expectedVersion: schedule.version }),
    });

    setSaving(false);

    if (!res.ok || !res.data) {
      // Entered values are deliberately NOT reset here — §5 "Error" requires them preserved.
      const mapped: Record<string, string> = {};
      for (const error of res.error?.errors ?? []) mapped[error.field] = error.message;
      setFieldErrors(mapped);
      setSaveError(res.error?.message ?? 'Could not save your schedule.');
      return;
    }

    setSchedule(res.data);
    setEntries(res.data.entries);
    setSavedMessage('Your working hours were saved.');
  }

  if (pageStatus === 'loading') {
    return (
      <main className={styles.page} aria-busy="true">
        <h1 className={styles.title}>Schedule</h1>
        <Skeleton height="18rem" />
      </main>
    );
  }

  if (pageStatus === 'error') {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Schedule</h1>
        <ErrorState title="We couldn't load your schedule" description={pageError ?? undefined} onRetry={() => void load()} />
      </main>
    );
  }

  const hasSchedule = entries.length > 0;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Schedule</h1>
        <Badge tone="neutral">{schedule?.timezone}</Badge>
      </header>

      {saveError ? (
        <Alert tone="error" title="That change wasn't saved">
          {saveError}
        </Alert>
      ) : null}
      {savedMessage ? <Alert tone="success">{savedMessage}</Alert> : null}

      <Card>
        <h2 className={styles.sectionTitle}>Working hours</h2>
        {hasSchedule ? (
          <>
            <p className={styles.sectionHint}>
              Times are in {schedule?.timezone}. A day with no hours set is treated as unavailable.
            </p>
            <WeeklyScheduleEditor entries={entries} onChange={setEntries} fieldErrors={fieldErrors} disabled={saving} />
          </>
        ) : (
          <EmptyState
            icon="calendar"
            title="No working hours set yet"
            description="Set the hours you normally work so customers can be matched with you. You stay discoverable either way."
            suggestions={['Turn on the days you work', 'Pick a start and end time for each', 'Add a date override for a one-off day off']}
          />
        )}

        <div className={styles.actions}>
          <Button variant="primary" loading={saving} onClick={() => void saveSchedule()}>
            Save working hours
          </Button>
        </div>
      </Card>

      <Card>
        <h2 className={styles.sectionTitle}>Date overrides</h2>
        <p className={styles.sectionHint}>An override replaces your weekly hours for that date entirely.</p>
        {overrides.length === 0 ? (
          <EmptyState compact icon="calendar-off" title="No overrides" description="Your weekly hours apply to every upcoming date." />
        ) : (
          <ul className={styles.overrideList}>
            {overrides.map((override) => (
              <li key={override.date} className={styles.overrideRow}>
                <span className={styles.overrideDate}>{override.date}</span>
                {override.isAvailable ? (
                  <Badge tone="info">
                    {formatMinute(override.startMinute ?? 0)}–{formatMinute(override.endMinute ?? 0)}
                  </Badge>
                ) : (
                  <Badge tone="neutral">Not working</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className={styles.sectionTitle}>Service areas</h2>
        {serviceAreas.length === 0 ? (
          <EmptyState
            compact
            icon="map-pin"
            title="No coverage limits set"
            description="You're currently matched with requests anywhere. Add an area to limit where you travel."
          />
        ) : (
          <ul className={styles.areaList}>
            {serviceAreas.map((area) => (
              <li key={area.serviceId ?? 'global'} className={styles.areaRow}>
                <span className={styles.areaScope}>{area.serviceId ? 'One service' : 'All services'}</span>
                {area.mode === 'radius' ? (
                  <span>
                    Within {area.radiusKm} km of {area.centerApproxAreaLabel ?? 'your saved address'}
                  </span>
                ) : null}
                {area.mode === 'cities' ? <span>{(area.cities ?? []).join(', ')}</span> : null}
                {area.mode === 'remote' ? <span>Remote / online — no travel limit</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
