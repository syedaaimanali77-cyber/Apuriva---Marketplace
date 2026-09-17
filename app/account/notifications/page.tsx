'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Icon, Skeleton, Switch } from '@/components';
import {
  NOTIFICATION_CATEGORIES,
  OUTBOUND_CHANNELS,
  type NotificationCategory,
  type NotificationDto,
  type NotificationPreferencesDto,
  type OutboundChannel,
} from '@/lib/types/notifications';
import styles from './notifications.module.css';

interface ApiErrorBody {
  code: string;
  message: string;
}

interface ApiResult<T> {
  ok: boolean;
  data?: T;
  page?: { nextOffset: number | null };
  error?: ApiErrorBody;
}

/** Same CSRF-cookie-echo pattern as app/account/addresses/page.tsx. */
function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { credentials: 'same-origin', ...init });
    const json = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, data: json.data as T, page: json.page } : { ok: false, error: json as ApiErrorBody };
  } catch {
    return { ok: false, error: { code: 'NETWORK_ERROR', message: 'We could not reach the server.' } };
  }
}

function mutation(method: 'POST' | 'PATCH', body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

const PAGE_SIZE = 20;

const CATEGORY_LABELS: Record<NotificationCategory, string> = {
  booking: 'Bookings',
  messages: 'Messages',
  payments: 'Payments',
  security: 'Security',
  promotions: 'Promotions',
  provider_activity: 'Provider activity',
  operational: 'Account & service notices',
};

const LOCKED_REASONS: Partial<Record<NotificationCategory, string>> = {
  security: "Security notifications can't be turned off.",
  payments: "Payment notifications can't be turned off.",
  operational: "Important account and service notices can't be turned off.",
};

const CHANNEL_LABELS: Record<OutboundChannel, string> = { push: 'Push', email: 'Email', sms: 'SMS' };

function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

type Status = 'loading' | 'error' | 'ready';

/**
 * Spec 026 §5 — the notification centre and notification preferences.
 *
 * Reading is EXPLICIT: rendering a notification never marks it read (a per-row action and "Mark all read"
 * do). Unread is conveyed by an "Unread" badge and heavier title weight, never colour alone. Security,
 * payments and operational categories render locked WITH their reason. Marketing consent is its own
 * explicit control, visibly separate from the promotions channel toggles. A failed action restores the
 * previous state and says so.
 */
export default function NotificationsPage() {
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<NotificationDto[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [inboxError, setInboxError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const [prefs, setPrefs] = useState<NotificationPreferencesDto | null>(null);
  const [prefsStatus, setPrefsStatus] = useState<Status>('loading');
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const loadInbox = useCallback(async () => {
    setStatus('loading');
    setInboxError(null);
    const res = await apiFetch<NotificationDto[]>(`/api/v1/users/me/notifications?limit=${PAGE_SIZE}&offset=0`);
    if (!res.ok) {
      setStatus('error');
      return;
    }
    setItems(res.data ?? []);
    setNextOffset(res.page?.nextOffset ?? null);
    setStatus('ready');
  }, []);

  const loadPrefs = useCallback(async () => {
    setPrefsStatus('loading');
    const res = await apiFetch<NotificationPreferencesDto>('/api/v1/users/me/notification-preferences');
    if (!res.ok || !res.data) {
      setPrefsStatus('error');
      return;
    }
    setPrefs(res.data);
    setPrefsStatus('ready');
  }, []);

  useEffect(() => {
    void loadInbox();
    void loadPrefs();
  }, [loadInbox, loadPrefs]);

  async function loadMore() {
    if (nextOffset === null) return;
    setLoadingMore(true);
    const res = await apiFetch<NotificationDto[]>(`/api/v1/users/me/notifications?limit=${PAGE_SIZE}&offset=${nextOffset}`);
    setLoadingMore(false);
    if (!res.ok) {
      setInboxError("We couldn't load more notifications. Try again.");
      return;
    }
    setItems((current) => {
      const seen = new Set(current.map((n) => n.id));
      return [...current, ...(res.data ?? []).filter((n) => !seen.has(n.id))];
    });
    setNextOffset(res.page?.nextOffset ?? null);
  }

  async function markRead(notification: NotificationDto) {
    const previous = items;
    setPendingIds((ids) => new Set(ids).add(notification.id));
    setInboxError(null);
    // The row stays in place; only its unread marker changes.
    setItems((current) => current.map((n) => (n.id === notification.id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n)));
    const res = await apiFetch<NotificationDto>(`/api/v1/users/me/notifications/${notification.id}/read`, mutation('POST'));
    setPendingIds((ids) => {
      const next = new Set(ids);
      next.delete(notification.id);
      return next;
    });
    if (!res.ok || !res.data) {
      setItems(previous);
      setInboxError("We couldn't mark that notification as read, so it's still shown as unread. Try again.");
      return;
    }
    setItems((current) => current.map((n) => (n.id === notification.id ? res.data! : n)));
    setAnnouncement('Notification marked as read.');
  }

  async function markAllRead() {
    const previous = items;
    setInboxError(null);
    const now = new Date().toISOString();
    setItems((current) => current.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    const res = await apiFetch<{ updated: number }>('/api/v1/users/me/notifications/read-all', mutation('POST'));
    if (!res.ok) {
      setItems(previous);
      setInboxError("We couldn't mark your notifications as read, so they're still shown as unread. Try again.");
      return;
    }
    setAnnouncement('All notifications marked as read.');
  }

  async function saveChannel(category: NotificationCategory, channel: OutboundChannel, enabled: boolean) {
    if (!prefs) return;
    const previous = prefs;
    setPrefsError(null);
    setSavingPrefs(true);
    setPrefs({ ...prefs, categories: { ...prefs.categories, [category]: { ...prefs.categories[category], [channel]: enabled } } });
    const res = await apiFetch<NotificationPreferencesDto>(
      '/api/v1/users/me/notification-preferences',
      mutation('PATCH', { categories: { [category]: { [channel]: enabled } }, version: previous.version }),
    );
    setSavingPrefs(false);
    if (!res.ok || !res.data) {
      setPrefs(previous);
      const reason =
        res.error?.code === 'CONFLICT'
          ? 'Your preferences were changed elsewhere. We reloaded them — please try again.'
          : res.error?.code === 'CATEGORY_NOT_OVERRIDABLE'
            ? res.error.message
            : "We couldn't save that change, so the setting was restored.";
      setPrefsError(`${CATEGORY_LABELS[category]} ${CHANNEL_LABELS[channel]} was not changed. ${reason}`);
      if (res.error?.code === 'CONFLICT') void loadPrefs();
      return;
    }
    setPrefs(res.data);
    setAnnouncement(`${CATEGORY_LABELS[category]} ${CHANNEL_LABELS[channel]} notifications ${enabled ? 'on' : 'off'}.`);
  }

  async function saveConsent(consent: boolean) {
    if (!prefs) return;
    const previous = prefs;
    setPrefsError(null);
    setSavingPrefs(true);
    setPrefs({ ...prefs, marketingConsentAt: consent ? new Date().toISOString() : null });
    const res = await apiFetch<{ marketingConsentAt: string | null }>('/api/v1/users/me/marketing-consent', mutation('POST', { consent }));
    setSavingPrefs(false);
    if (!res.ok || !res.data) {
      setPrefs(previous);
      setPrefsError("We couldn't update your marketing consent, so it was left unchanged. Try again.");
      return;
    }
    // Consent changes the preference row's version; reload so the next toggle sends the current one.
    await loadPrefs();
    setAnnouncement(consent ? 'Marketing consent given.' : 'Marketing consent withdrawn.');
  }

  const unreadCount = items.filter((n) => !n.readAt).length;

  return (
    <main className={styles.page}>
      <section className={styles.section} aria-labelledby="notifications-heading" aria-busy={status === 'loading'}>
        <div className={styles.header}>
          <h1 id="notifications-heading" className={styles.title}>
            Notifications
          </h1>
          {status === 'ready' && items.length > 0 ? (
            <Button variant="secondary" size="sm" onClick={markAllRead} disabled={unreadCount === 0}>
              Mark all read
            </Button>
          ) : null}
        </div>

        {inboxError ? <Alert tone="error">{inboxError}</Alert> : null}

        {status === 'loading' ? (
          <div className={styles.list} data-testid="notifications-loading">
            <Skeleton height={88} radius="var(--radius-lg)" />
            <Skeleton height={88} radius="var(--radius-lg)" />
            <Skeleton height={88} radius="var(--radius-lg)" />
          </div>
        ) : status === 'error' ? (
          <ErrorState
            title="We couldn't load your notifications"
            description="Check your connection and try again."
            onRetry={() => void loadInbox()}
          />
        ) : items.length === 0 ? (
          <EmptyState icon="bell" title="You're all caught up" description="New notifications about your bookings, messages and payments will appear here." />
        ) : (
          <>
            <ul className={styles.list}>
              {items.map((notification) => {
                const unread = !notification.readAt;
                return (
                  <li key={notification.id}>
                    <Card elevation="flat" className={styles.item}>
                      <div className={styles.itemBody}>
                        <p className={`${styles.itemTitle} ${unread ? styles.itemTitleUnread : ''}`}>
                          {unread ? (
                            <Badge tone="brand" icon={null} size="sm">
                              Unread
                            </Badge>
                          ) : null}
                          {notification.title}
                        </p>
                        <p className={styles.itemText}>{notification.body}</p>
                        <p className={styles.itemMeta}>
                          {CATEGORY_LABELS[notification.category]} · {formatInstant(notification.createdAt)}
                        </p>
                      </div>
                      {unread ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={pendingIds.has(notification.id)}
                          onClick={() => void markRead(notification)}
                          aria-label={`Mark "${notification.title}" as read`}
                        >
                          Mark read
                        </Button>
                      ) : null}
                    </Card>
                  </li>
                );
              })}
            </ul>
            {nextOffset !== null ? (
              <Button variant="secondary" className={styles.more} loading={loadingMore} onClick={() => void loadMore()}>
                Load more
              </Button>
            ) : null}
          </>
        )}
      </section>

      <section className={styles.section} aria-labelledby="preferences-heading" aria-busy={prefsStatus === 'loading'}>
        <h2 id="preferences-heading" className={styles.sectionTitle}>
          Notification preferences
        </h2>
        <p className={styles.hint}>In-app notifications are always kept here. Choose which other channels you want for each kind.</p>

        {prefsError ? <Alert tone="error">{prefsError}</Alert> : null}

        {prefsStatus === 'loading' ? (
          <Skeleton height={320} radius="var(--radius-lg)" />
        ) : prefsStatus === 'error' || !prefs ? (
          <ErrorState title="We couldn't load your preferences" onRetry={() => void loadPrefs()} compact />
        ) : (
          <>
            <Card elevation="flat">
              {NOTIFICATION_CATEGORIES.map((category) => {
                const locked = prefs.nonOverridableCategories.includes(category);
                const headingId = `category-${category}`;
                return (
                  <div key={category} className={styles.category} role="group" aria-labelledby={headingId}>
                    <h3 id={headingId} className={styles.categoryTitle}>
                      {CATEGORY_LABELS[category]}
                    </h3>
                    {locked ? (
                      <p className={styles.locked}>
                        <Icon name="lock" size="sm" />
                        {LOCKED_REASONS[category]} You&apos;ll always get them in-app and by email.
                      </p>
                    ) : (
                      <>
                        {category === 'promotions' ? (
                          <p className={styles.hint}>
                            Promotions are only sent if you also give marketing consent below — both are required.
                          </p>
                        ) : null}
                        <div className={styles.toggles}>
                          {OUTBOUND_CHANNELS.map((channel) => (
                            <Switch
                              key={channel}
                              id={`${category}-${channel}`}
                              label={`${CHANNEL_LABELS[channel]}`}
                              description={`${CATEGORY_LABELS[category]} by ${CHANNEL_LABELS[channel].toLowerCase()}`}
                              checked={prefs.categories[category][channel]}
                              disabled={savingPrefs}
                              onChange={(next) => void saveChannel(category, channel, next)}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </Card>

            <Card elevation="subtle" emphasis="accent" className={styles.consent}>
              <h3 className={styles.categoryTitle}>Marketing consent</h3>
              <p className={styles.hint}>
                Allow us to send you promotional offers and news. This is separate from the Promotions channels above:
                promotions are sent only when you give consent AND switch on at least one Promotions channel. You can
                withdraw consent at any time.
              </p>
              <Switch
                id="marketing-consent"
                label="I agree to receive promotional notifications"
                description={
                  prefs.marketingConsentAt ? `Consent given ${formatInstant(prefs.marketingConsentAt)}` : 'No consent given'
                }
                checked={prefs.marketingConsentAt !== null}
                disabled={savingPrefs}
                onChange={(next) => void saveConsent(next)}
              />
            </Card>
          </>
        )}
      </section>

      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>
    </main>
  );
}
