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
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatDateTime } from '@/lib/i18n/format';
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

const CATEGORY_LABELS: Record<NotificationCategory, MessageKey> = {
  booking: 'notificationCentre.category.booking',
  messages: 'notificationCentre.category.messages',
  payments: 'notificationCentre.category.payments',
  security: 'notificationCentre.category.security',
  promotions: 'notificationCentre.category.promotions',
  provider_activity: 'notificationCentre.category.provider_activity',
  operational: 'notificationCentre.category.operational',
};

const LOCKED_REASONS: Partial<Record<NotificationCategory, MessageKey>> = {
  security: 'notificationCentre.locked.security',
  payments: 'notificationCentre.locked.payments',
  operational: 'notificationCentre.locked.operational',
};

const CHANNEL_LABELS: Record<OutboundChannel, MessageKey> = {
  push: 'notificationCentre.channel.push',
  email: 'notificationCentre.channel.email',
  sms: 'notificationCentre.channel.sms',
};

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
  // Spec 042: platform text here is translated; each notification's own title/body arrive already
  // rendered for the reader's locale by the inbox (spec 042 §3.8).
  const { locale, t } = useLocale();
  const formatInstant = (iso: string) => formatDateTime(iso, locale, { dateStyle: 'medium', timeStyle: 'short' });
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
      setInboxError(t('notificationCentre.loadMoreFailed'));
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
      setInboxError(t('notificationCentre.markReadFailed'));
      return;
    }
    setItems((current) => current.map((n) => (n.id === notification.id ? res.data! : n)));
    setAnnouncement(t('notificationCentre.markedRead'));
  }

  async function markAllRead() {
    const previous = items;
    setInboxError(null);
    const now = new Date().toISOString();
    setItems((current) => current.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    const res = await apiFetch<{ updated: number }>('/api/v1/users/me/notifications/read-all', mutation('POST'));
    if (!res.ok) {
      setItems(previous);
      setInboxError(t('notificationCentre.markAllFailed'));
      return;
    }
    setAnnouncement(t('notificationCentre.allMarkedRead'));
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
          ? t('notificationCentre.conflict')
          : res.error?.code === 'CATEGORY_NOT_OVERRIDABLE'
            ? res.error.message
            : t('notificationCentre.saveFailed');
      setPrefsError(t('notificationCentre.notChanged', { category: t(CATEGORY_LABELS[category]), channel: t(CHANNEL_LABELS[channel]), reason }));
      if (res.error?.code === 'CONFLICT') void loadPrefs();
      return;
    }
    setPrefs(res.data);
    setAnnouncement(
      t(enabled ? 'notificationCentre.channelOn' : 'notificationCentre.channelOff', {
        category: t(CATEGORY_LABELS[category]),
        channel: t(CHANNEL_LABELS[channel]),
      }),
    );
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
      setPrefsError(t('notificationCentre.consentFailed'));
      return;
    }
    // Consent changes the preference row's version; reload so the next toggle sends the current one.
    await loadPrefs();
    setAnnouncement(consent ? t('notificationCentre.consentGiven') : t('notificationCentre.consentWithdrawn'));
  }

  const unreadCount = items.filter((n) => !n.readAt).length;

  return (
    <main className={styles.page}>
      <section className={styles.section} aria-labelledby="notifications-heading" aria-busy={status === 'loading'}>
        <div className={styles.header}>
          <h1 id="notifications-heading" className={styles.title}>
            {t('notificationCentre.title')}
          </h1>
          {status === 'ready' && items.length > 0 ? (
            <Button variant="secondary" size="sm" onClick={markAllRead} disabled={unreadCount === 0}>
              {t('notificationCentre.markAll')}
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
            title={t('notificationCentre.loadFailedTitle')}
            description={t('notificationCentre.loadFailedDescription')}
            onRetry={() => void loadInbox()}
          />
        ) : items.length === 0 ? (
          <EmptyState icon="bell" title={t('notificationCentre.emptyTitle')} description={t('notificationCentre.emptyDescription')} />
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
                              {t('notificationCentre.unread')}
                            </Badge>
                          ) : null}
                          {notification.title}
                        </p>
                        <p className={styles.itemText}>{notification.body}</p>
                        <p className={styles.itemMeta}>
                          {t(CATEGORY_LABELS[notification.category])} · {formatInstant(notification.createdAt)}
                        </p>
                      </div>
                      {unread ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          loading={pendingIds.has(notification.id)}
                          onClick={() => void markRead(notification)}
                          aria-label={t('notificationCentre.markReadLabel', { title: notification.title })}
                        >
                          {t('notificationCentre.markRead')}
                        </Button>
                      ) : null}
                    </Card>
                  </li>
                );
              })}
            </ul>
            {nextOffset !== null ? (
              <Button variant="secondary" className={styles.more} loading={loadingMore} onClick={() => void loadMore()}>
                {t('notificationCentre.loadMore')}
              </Button>
            ) : null}
          </>
        )}
      </section>

      <section className={styles.section} aria-labelledby="preferences-heading" aria-busy={prefsStatus === 'loading'}>
        <h2 id="preferences-heading" className={styles.sectionTitle}>
          {t('notificationCentre.preferencesTitle')}
        </h2>
        <p className={styles.hint}>{t('notificationCentre.preferencesHint')}</p>

        {prefsError ? <Alert tone="error">{prefsError}</Alert> : null}

        {prefsStatus === 'loading' ? (
          <Skeleton height={320} radius="var(--radius-lg)" />
        ) : prefsStatus === 'error' || !prefs ? (
          <ErrorState title={t('notificationCentre.prefsFailedTitle')} onRetry={() => void loadPrefs()} compact />
        ) : (
          <>
            <Card elevation="flat">
              {NOTIFICATION_CATEGORIES.map((category) => {
                const locked = prefs.nonOverridableCategories.includes(category);
                const headingId = `category-${category}`;
                return (
                  <div key={category} className={styles.category} role="group" aria-labelledby={headingId}>
                    <h3 id={headingId} className={styles.categoryTitle}>
                      {t(CATEGORY_LABELS[category])}
                    </h3>
                    {locked ? (
                      <p className={styles.locked}>
                        <Icon name="lock" size="sm" />
                        {LOCKED_REASONS[category] ? t(LOCKED_REASONS[category]!) : null} {t('notificationCentre.lockedTail')}
                      </p>
                    ) : (
                      <>
                        {category === 'promotions' ? (
                          <p className={styles.hint}>{t('notificationCentre.promotionsHint')}</p>
                        ) : null}
                        <div className={styles.toggles}>
                          {OUTBOUND_CHANNELS.map((channel) => (
                            <Switch
                              key={channel}
                              id={`${category}-${channel}`}
                              label={t(CHANNEL_LABELS[channel])}
                              description={t('notificationCentre.categoryBy', {
                                category: t(CATEGORY_LABELS[category]),
                                channel: t(CHANNEL_LABELS[channel]).toLowerCase(),
                              })}
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
              <h3 className={styles.categoryTitle}>{t('notificationCentre.consentTitle')}</h3>
              <p className={styles.hint}>{t('notificationCentre.consentHint')}</p>
              <Switch
                id="marketing-consent"
                label={t('notificationCentre.consentLabel')}
                description={
                  prefs.marketingConsentAt
                    ? t('notificationCentre.consentGivenAt', { when: formatInstant(prefs.marketingConsentAt) })
                    : t('notificationCentre.noConsent')
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
