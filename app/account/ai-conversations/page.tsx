'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AiMessage } from '@/components/AiMessage';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { Card } from '@/components/Card';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Input } from '@/components/Input';
import { Skeleton } from '@/components/Skeleton';
import type { AiConversationSummaryDto, AiMessageDto } from '@/lib/types/ai-assistant';
import { aiFetch, aiMutation, formatAiInstant } from '@/app/_components/ask-apuriva-client';
import { useLocale } from '@/app/_components/LocaleProvider';
import styles from '@/app/_components/ai-account.module.css';

const PAGE_SIZE = 20;
type Status = 'loading' | 'error' | 'ready';
type Pending = { kind: 'one'; conversation: AiConversationSummaryDto } | { kind: 'all' } | null;

/**
 * Spec 034 §5 — view, search, delete and clear Ask Apuriva conversations (master spec §82, AC-8).
 * Temporary conversations are never stored, so they never appear here. Every destructive action goes
 * through `ConfirmDialog`; clearing history states that AI memory and activity are kept.
 */
export default function AiConversationsPage() {
  const { locale, t } = useLocale();
  const [status, setStatus] = useState<Status>('loading');
  const [items, setItems] = useState<AiConversationSummaryDto[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const [deleting, setDeleting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{ status: Status; messages: AiMessageDto[] }>({ status: 'loading', messages: [] });

  const listUrl = (q: string, offset: number) =>
    `/api/v1/ai/conversations?limit=${PAGE_SIZE}&offset=${offset}${q ? `&q=${encodeURIComponent(q)}` : ''}`;

  const load = useCallback(async (q: string) => {
    setStatus('loading');
    setError(null);
    const res = await aiFetch<AiConversationSummaryDto[]>(listUrl(q, 0));
    if (!res.ok) {
      setStatus('error');
      return;
    }
    setItems(res.data ?? []);
    setNextOffset(res.page?.nextOffset ?? null);
    setStatus('ready');
  }, []);

  useEffect(() => {
    void load('');
  }, [load]);

  function search(e: FormEvent) {
    e.preventDefault();
    setActiveQuery(query.trim());
    setOpenId(null);
    void load(query.trim());
  }

  async function loadMore() {
    if (nextOffset === null) return;
    setLoadingMore(true);
    const res = await aiFetch<AiConversationSummaryDto[]>(listUrl(activeQuery, nextOffset));
    setLoadingMore(false);
    if (!res.ok) {
      setError(t('aiAccount.conversations.loadMoreFailed'));
      return;
    }
    setItems((current) => [...current, ...(res.data ?? []).filter((c) => !current.some((x) => x.id === c.id))]);
    setNextOffset(res.page?.nextOffset ?? null);
  }

  async function toggle(conversation: AiConversationSummaryDto) {
    if (openId === conversation.id) {
      setOpenId(null);
      return;
    }
    setOpenId(conversation.id);
    setTranscript({ status: 'loading', messages: [] });
    const res = await aiFetch<AiMessageDto[]>(`/api/v1/ai/conversations/${encodeURIComponent(conversation.id)}/messages?limit=100`);
    setTranscript(res.ok ? { status: 'ready', messages: res.data ?? [] } : { status: 'error', messages: [] });
  }

  async function confirmDelete() {
    const target = pending;
    if (!target) return;
    setDeleting(true);
    setError(null);
    const url = target.kind === 'one' ? `/api/v1/ai/conversations/${encodeURIComponent(target.conversation.id)}` : '/api/v1/ai/conversations';
    const res = await aiFetch(url, aiMutation('DELETE'));
    setDeleting(false);
    setPending(null);
    if (!res.ok) {
      setError(target.kind === 'all' ? t('aiAccount.conversations.clearFailed') : t('aiAccount.conversations.deleteFailed'));
      return;
    }
    if (target.kind === 'all') {
      setItems([]);
      setNextOffset(null);
      setAnnouncement(t('aiAccount.conversations.cleared'));
    } else {
      setItems((current) => current.filter((c) => c.id !== target.conversation.id));
      setAnnouncement(t('aiAccount.conversations.deleted'));
    }
    setOpenId(null);
  }

  return (
    <main className={styles.page}>
      <p role="status" aria-live="polite" className="apr-visually-hidden">
        {announcement}
      </p>
      <section className={styles.section} aria-labelledby="ai-conversations-heading" aria-busy={status === 'loading'}>
        <div className={styles.header}>
          <h1 id="ai-conversations-heading" className={styles.title}>
            {t('aiAccount.conversations.title')}
          </h1>
          {status === 'ready' && items.length > 0 && !activeQuery ? (
            <Button variant="secondary" size="sm" onClick={() => setPending({ kind: 'all' })}>
              {t('aiAccount.conversations.clearHistory')}
            </Button>
          ) : null}
        </div>
        <p className={styles.hint}>{t('aiAccount.conversations.temporaryHint')}</p>

        <form className={styles.search} role="search" onSubmit={search}>
          <Input
            type="search"
            aria-label={t('aiAccount.conversations.searchLabel')}
            placeholder={t('aiAccount.conversations.searchLabel')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            iconLeft="search"
          />
          <Button type="submit" variant="secondary" size="sm">
            {t('aiAccount.conversations.search')}
          </Button>
        </form>

        {error ? <Alert tone="error">{error}</Alert> : null}

        {status === 'loading' ? (
          <div className={styles.list} data-testid="ai-conversations-loading">
            <Skeleton height={72} radius="var(--radius-lg)" />
            <Skeleton height={72} radius="var(--radius-lg)" />
          </div>
        ) : status === 'error' ? (
          <ErrorState
            title={t('aiAccount.conversations.loadFailedTitle')}
            description={t('aiAccount.conversations.loadFailedDescription')}
            onRetry={() => void load(activeQuery)}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon="message-circle"
            title={activeQuery ? t('aiAccount.conversations.noMatchTitle') : t('aiAccount.conversations.emptyTitle')}
            description={activeQuery ? t('aiAccount.conversations.noMatchDescription') : t('aiAccount.conversations.emptyDescription')}
          />
        ) : (
          <>
            <ul className={styles.list}>
              {items.map((conversation) => {
                const title = conversation.preview || t('aiAccount.conversations.untitled');
                return (
                  <li key={conversation.id}>
                    <Card elevation="flat">
                      <div className={styles.row}>
                        <div className={styles.rowBody}>
                          <p className={styles.rowTitle}>{title}</p>
                          <p className={styles.rowMeta}>
                            {t('aiAccount.conversations.lastUpdated', { when: formatAiInstant(conversation.updatedAt, locale) })}
                          </p>
                        </div>
                        <div className={styles.actions}>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-expanded={openId === conversation.id}
                            onClick={() => void toggle(conversation)}
                          >
                            {openId === conversation.id ? t('aiAccount.conversations.hide') : t('aiAccount.conversations.view')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t('aiAccount.conversations.deleteLabel', { title })}
                            onClick={() => setPending({ kind: 'one', conversation })}
                          >
                            {t('aiAccount.conversations.delete')}
                          </Button>
                        </div>
                      </div>
                      {openId === conversation.id ? (
                        <div className={styles.transcript} aria-label={t('aiAccount.conversations.transcript')} role="region">
                          {transcript.status === 'loading' ? (
                            <Skeleton height={48} />
                          ) : transcript.status === 'error' ? (
                            <ErrorState compact title={t('aiAccount.conversations.transcriptFailed')} onRetry={() => void toggle(conversation)} />
                          ) : (
                            transcript.messages.map((m) => (
                              <AiMessage key={m.id} role={m.role} timestamp={formatAiInstant(m.createdAt, locale)}>
                                {m.body}
                              </AiMessage>
                            ))
                          )}
                        </div>
                      ) : null}
                    </Card>
                  </li>
                );
              })}
            </ul>
            {nextOffset !== null ? (
              <Button variant="secondary" loading={loadingMore} onClick={() => void loadMore()}>
                {t('aiAccount.conversations.loadMore')}
              </Button>
            ) : null}
          </>
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'all' ? t('aiAccount.conversations.clearTitle') : t('aiAccount.conversations.deleteTitle')}
        description={
          pending?.kind === 'all' ? t('aiAccount.conversations.clearDescription') : t('aiAccount.conversations.deleteDescription')
        }
        confirmLabel={pending?.kind === 'all' ? t('aiAccount.conversations.clearHistory') : t('aiAccount.conversations.delete')}
        pending={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPending(null)}
      />
    </main>
  );
}
