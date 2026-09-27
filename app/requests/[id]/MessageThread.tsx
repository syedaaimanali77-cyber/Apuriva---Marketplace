'use client';

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card } from '@/components';
import { RequestMessageThread, THREAD_REFRESH_INTERVAL_MS } from '@/app/_components/RequestMessageThread';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { MessageThreadSummaryDto } from '@/lib/types/negotiation';
import styles from './negotiation.module.css';

export interface CustomerMessageThreadProps {
  requestId: string;
  providerProfileId: string;
  providerName: string;
  canSend: boolean;
}

/** Spec 019 §5 — the customer's side of one pre-selection thread. */
export function CustomerMessageThread({ requestId, providerProfileId, providerName, canSend }: CustomerMessageThreadProps) {
  const { t } = useLocale();
  const base = `/api/v1/requests/${encodeURIComponent(requestId)}/message-threads/${encodeURIComponent(providerProfileId)}/messages`;
  return (
    <RequestMessageThread
      listUrl={base}
      postUrl={base}
      viewerRole="customer"
      counterpartyLabel={providerName}
      canSend={canSend}
      closedMessage={t('threads.closedOnSelect')}
    />
  );
}

/**
 * Spec 019 §5 — the customer's thread list for a request (`GET /requests/{id}/message-threads`): only
 * providers who made an offer or asked a question — never spec 017's distribution pool. Renders nothing
 * until at least one thread exists.
 */
export function RequestThreadsPanel({ requestId }: { requestId: string }) {
  const { t } = useLocale();
  const [threads, setThreads] = useState<MessageThreadSummaryDto[]>([]);
  const [openFor, setOpenFor] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/requests/${encodeURIComponent(requestId)}/message-threads`, { credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(json.data)) setThreads(json.data as MessageThreadSummaryDto[]);
    } catch {
      // A thread list failure never breaks the request view; the next refresh retries.
    }
  }, [requestId]);

  useEffect(() => {
    load();
    const handle = setInterval(load, THREAD_REFRESH_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [load]);

  if (threads.length === 0) return null;

  return (
    <section className={styles.panel} aria-labelledby="threads-heading">
      <h2 id="threads-heading" className={styles.panelTitle}>
        {t('threads.title')}
      </h2>
      {threads.map((thread) => {
        const name = thread.providerBusinessName ?? t('threads.provider');
        const open = openFor === thread.providerProfileId;
        return (
          <Card key={thread.providerProfileId} elevation="flat" className={styles.threadCard}>
            <div className={styles.threadHeader}>
              <div className={styles.threadMeta}>
                <span className={styles.threadName}>{name}</span>
                <span className={styles.hint}>
                  {thread.messageCount === 1 ? t('threads.messageOne') : t('threads.messageMany', { count: thread.messageCount })}
                </span>
                {!thread.canSend ? (
                  <Badge tone="neutral" size="sm">
                    {t('threads.closed')}
                  </Badge>
                ) : null}
              </div>
              <Button variant="secondary" size="sm" onClick={() => setOpenFor(open ? null : thread.providerProfileId)}>
                {open ? t('threads.hide') : t('threads.open')}
              </Button>
            </div>
            {open ? (
              <CustomerMessageThread
                requestId={requestId}
                providerProfileId={thread.providerProfileId}
                providerName={name}
                canSend={thread.canSend}
              />
            ) : null}
          </Card>
        );
      })}
    </section>
  );
}
