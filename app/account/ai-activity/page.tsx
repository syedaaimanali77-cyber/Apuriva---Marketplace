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
import styles from '@/app/_components/ai-account.module.css';

const PAGE_SIZE = 50;
type Status = 'loading' | 'error' | 'ready';

const RISK_TEXT: Record<AiActionDto['riskTier'], string> = {
  low: 'Low risk',
  medium: 'Medium risk',
  high: 'High risk',
};

/**
 * §3.8 / master spec §86 — no action is genuinely reversible yet, so NO Undo is ever offered. Every
 * entry explains that and links the recovery path to its request or booking instead.
 */
function RecoveryNote({ action }: { action: AiActionDto }) {
  if (!action.related) return <>This can&apos;t be undone here.</>;
  const href = action.related.type === 'booking' ? `/bookings/${action.related.id}` : `/requests/${action.related.id}`;
  return (
    <>
      This can&apos;t be undone here. To change it, go to the related{' '}
      <Link href={href}>{action.related.type === 'booking' ? 'booking' : 'request'}</Link>.
    </>
  );
}

function detailFor(action: AiActionDto) {
  const confirmation = action.requiredConfirmation ? 'Needed your confirmation' : 'No confirmation needed';
  const result = action.result === 'failed' ? "Didn't complete" : 'Completed';
  return (
    <>
      {result} · {RISK_TEXT[action.riskTier]} · {confirmation}. <RecoveryNote action={action} />
    </>
  );
}

function groupByDay(actions: AiActionDto[]): AiActivityGroup[] {
  const groups = new Map<string, AiActivityGroup>();
  for (const action of actions) {
    const day = new Date(action.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
    if (!groups.has(day)) groups.set(day, { label: day, entries: [] });
    groups.get(day)!.entries.push({
      label: action.actionLabel,
      detail: detailFor(action),
      time: new Date(action.createdAt).toLocaleTimeString(undefined, { timeStyle: 'short' }),
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
          Ask Apuriva activity
        </h1>
        <p className={styles.hint}>What Ask Apuriva did for you, including in conversations you have since deleted.</p>

        {status === 'loading' ? (
          <div className={styles.list} data-testid="ai-activity-loading">
            <Skeleton height={56} radius="var(--radius-lg)" />
            <Skeleton height={56} radius="var(--radius-lg)" />
          </div>
        ) : status === 'error' ? (
          <ErrorState title="We couldn't load your AI activity" description="Check your connection and try again." onRetry={() => void load()} />
        ) : items.length === 0 ? (
          <EmptyState icon="clock" title="No AI activity yet" description="Actions Ask Apuriva takes for you will be listed here." />
        ) : (
          <>
            {unknown.length > 0 ? (
              <section className={styles.section} aria-labelledby="ai-activity-unknown-heading">
                <h2 id="ai-activity-unknown-heading" className={styles.sectionTitle}>
                  Outcome unknown
                </h2>
                <p className={styles.hint}>We couldn&apos;t confirm how these ended. Check the related booking or request.</p>
                <ul className={styles.list}>
                  {unknown.map((action) => (
                    <li key={action.id}>
                      <Card elevation="flat">
                        <div className={styles.rowBody}>
                          <p className={styles.rowTitle}>
                            <Badge tone="warning" icon={null} size="sm">
                              Outcome unknown
                            </Badge>{' '}
                            {action.actionLabel}
                          </p>
                          <p className={styles.rowMeta}>
                            {formatAiInstant(action.createdAt)} · {RISK_TEXT[action.riskTier]} ·{' '}
                            {action.requiredConfirmation ? 'Needed your confirmation' : 'No confirmation needed'}
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
            {settled.length > 0 ? <AiActivityLog groups={groupByDay(settled)} /> : null}
            {nextOffset !== null ? (
              <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
                Load more
              </Button>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
