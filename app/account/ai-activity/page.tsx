'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AiActivityLog, type AiActivityGroup } from '@/components/AiActivityLog';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/Skeleton';
import type { AiActionDto } from '@/lib/types/ai-assistant';
import { aiFetch, formatAiInstant } from '@/app/_components/ask-apuriva-client';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import { formatDate, formatTime } from '@/lib/i18n/format';
import type { Translator } from '@/lib/i18n/translator';
import styles from '@/app/_components/ai-account.module.css';

const PAGE_SIZE = 50;
type Status = 'loading' | 'error' | 'ready';

const RISK_TEXT: Record<AiActionDto['riskTier'], MessageKey> = {
  low: 'aiAccount.activity.risk.low',
  medium: 'aiAccount.activity.risk.medium',
  high: 'aiAccount.activity.risk.high',
};

/**
 * §3.8 / master spec §86 — no action is genuinely reversible yet, so NO Undo is ever offered. Every
 * entry explains that and links the recovery path to its request or booking instead.
 */
function RecoveryNote({ action }: { action: AiActionDto }) {
  const { t } = useLocale();
  if (!action.related) return <>{t('aiAccount.activity.cantUndo')}</>;
  const href = action.related.type === 'booking' ? `/bookings/${action.related.id}` : `/requests/${action.related.id}`;
  return (
    <>
      {t('aiAccount.activity.changeVia')}{' '}
      <Link href={href}>{action.related.type === 'booking' ? t('aiAccount.activity.booking') : t('aiAccount.activity.request')}</Link>.
    </>
  );
}

function detailFor(t: Translator, action: AiActionDto) {
  const confirmation = action.requiredConfirmation ? t('aiAccount.activity.neededConfirmation') : t('aiAccount.activity.noConfirmation');
  const result = action.result === 'failed' ? t('aiAccount.activity.didntComplete') : t('aiAccount.activity.completed');
  return (
    <>
      {result} · {t(RISK_TEXT[action.riskTier])} · {confirmation}. <RecoveryNote action={action} />
    </>
  );
}

/** Spec 042 X-11: grouped and timed with the shared formatters, in the reader's locale. */
function groupByDay(t: Translator, locale: string, actions: AiActionDto[]): AiActivityGroup[] {
  const groups = new Map<string, AiActivityGroup>();
  for (const action of actions) {
    const day = formatDate(action.createdAt, locale, { dateStyle: 'medium' });
    if (!groups.has(day)) groups.set(day, { label: day, entries: [] });
    groups.get(day)!.entries.push({
      label: action.actionLabel,
      detail: detailFor(t, action),
      time: formatTime(action.createdAt, locale, { timeStyle: 'short' }),
      status: action.result === 'failed' ? 'failed' : 'done',
      confirmed: action.requiredConfirmation,
    });
  }
  return [...groups.values()];
}

/**
 * Spec 034 §5 — AI activity history (master spec §85, AC-10, AC-11): what happened in plain language,
 * when, the related request or booking, the result and whether confirmation was required. Never a raw
 * tool identifier, never an Undo.
 *
 * `AiActivityLog` only has `done`/`failed` states and draws a check for anything not failed, so an
 * action whose outcome is UNKNOWN (`pending`) is never passed to it — that would look like a success
 * (master spec §92). Those entries render in their own text-only "Outcome unknown" list.
 */
export default function AiActivityPage() {
  const { locale, t } = useLocale();
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<AiActionDto[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    const res = await aiFetch<AiActionDto[]>(`/api/v1/ai/activity?limit=${PAGE_SIZE}&offset=0`);
    if (!res.ok) {
      setStatus('error');
      return;
    }
    setItems(res.data ?? []);
    setNextOffset(res.page?.nextOffset ?? null);
    setStatus('ready');
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (nextOffset === null) return;
    setLoadingMore(true);
    const res = await aiFetch<AiActionDto[]>(`/api/v1/ai/activity?limit=${PAGE_SIZE}&offset=${nextOffset}`);
    setLoadingMore(false);
    if (!res.ok) return;
    setItems((current) => [...current, ...(res.data ?? []).filter((a) => !current.some((x) => x.id === a.id))]);
    setNextOffset(res.page?.nextOffset ?? null);
  }

  const settled = items.filter((a) => a.result !== 'pending');
  const unknown = items.filter((a) => a.result === 'pending');

  return (
    <main className={styles.page}>
      <section className={styles.section} aria-labelledby="ai-activity-heading" aria-busy={status === 'loading'}>
        <h1 id="ai-activity-heading" className={styles.title}>
          {t('aiAccount.activity.title')}
        </h1>
        <p className={styles.hint}>{t('aiAccount.activity.hint')}</p>

        {status === 'loading' ? (
          <div className={styles.list} data-testid="ai-activity-loading">
            <Skeleton height={56} radius="var(--radius-lg)" />
            <Skeleton height={56} radius="var(--radius-lg)" />
          </div>
        ) : status === 'error' ? (
          <ErrorState
            title={t('aiAccount.activity.loadFailedTitle')}
            description={t('aiAccount.activity.loadFailedDescription')}
            onRetry={() => void load()}
          />
        ) : items.length === 0 ? (
          <EmptyState icon="clock" title={t('aiAccount.activity.emptyTitle')} description={t('aiAccount.activity.emptyDescription')} />
        ) : (
          <>
            {unknown.length > 0 ? (
              <section className={styles.section} aria-labelledby="ai-activity-unknown-heading">
                <h2 id="ai-activity-unknown-heading" className={styles.sectionTitle}>
                  {t('aiAccount.activity.unknown')}
                </h2>
                <p className={styles.hint}>{t('aiAccount.activity.unknownHint')}</p>
                <ul className={styles.list}>
                  {unknown.map((action) => (
                    <li key={action.id}>
                      <Card elevation="flat">
                        <div className={styles.rowBody}>
                          <p className={styles.rowTitle}>
                            <Badge tone="warning" icon={null} size="sm">
                              {t('aiAccount.activity.unknown')}
                            </Badge>{' '}
                            {action.actionLabel}
                          </p>
                          <p className={styles.rowMeta}>
                            {formatAiInstant(action.createdAt, locale)} · {t(RISK_TEXT[action.riskTier])} ·{' '}
                            {action.requiredConfirmation ? t('aiAccount.activity.neededConfirmation') : t('aiAccount.activity.noConfirmation')}
                          </p>
                          <p className={styles.rowMeta}>
                            <RecoveryNote action={action} />
                          </p>
                        </div>
                      </Card>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {settled.length > 0 ? <AiActivityLog groups={groupByDay(t, locale, settled)} /> : null}
            {nextOffset !== null ? (
              <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
                {t('aiAccount.activity.loadMore')}
              </Button>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
