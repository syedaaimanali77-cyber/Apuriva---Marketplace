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
      setError("We couldn't load more conversations. Try again.");
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
      setError(target.kind === 'all' ? "We couldn't clear your history. Nothing was deleted." : "We couldn't delete that conversation. Try again.");
      return;
    }
    if (target.kind === 'all') {
      setItems([]);
      setNextOffset(null);
      setAnnouncement('Conversation history cleared.');
    } else {
      setItems((current) => current.filter((c) => c.id !== target.conversation.id));
      setAnnouncement('Conversation deleted.');
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
            Ask Apuriva conversations
          </h1>
          {status === 'ready' && items.length > 0 && !activeQuery ? (
            <Button variant="secondary" size="sm" onClick={() => setPending({ kind: 'all' })}>
              Clear history
            </Button>
          ) : null}
        </div>
        <p className={styles.hint}>Temporary conversations are never saved, so they never appear here.</p>

        <form className={styles.search} role="search" onSubmit={search}>
          <Input
            type="search"
            aria-label="Search your conversations"
            placeholder="Search your conversations"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            iconLeft="search"
          />
          <Button type="submit" variant="secondary" size="sm">
            Search
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
            title="We couldn't load your conversations"
            description="Check your connection and try again."
            onRetry={() => void load(activeQuery)}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon="message-circle"
            title={activeQuery ? 'No conversations match your search' : 'No conversations yet'}
            description={activeQuery ? 'Try different words.' : 'Conversations you have with Ask Apuriva will appear here.'}
          />
        ) : (
          <>
            <ul className={styles.list}>
              {items.map((conversation) => {
                const title = conversation.preview || 'Conversation';
                return (
                  <li key={conversation.id}>
                    <Card elevation="flat">
                      <div className={styles.row}>
                        <div className={styles.rowBody}>
                          <p className={styles.rowTitle}>{title}</p>
                          <p className={styles.rowMeta}>Last updated {formatAiInstant(conversation.updatedAt)}</p>
                        </div>
                        <div className={styles.actions}>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-expanded={openId === conversation.id}
                            onClick={() => void toggle(conversation)}
                          >
                            {openId === conversation.id ? 'Hide' : 'View'}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Delete conversation "${title}"`}
                            onClick={() => setPending({ kind: 'one', conversation })}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                      {openId === conversation.id ? (
                        <div className={styles.transcript} aria-label="Conversation transcript" role="region">
                          {transcript.status === 'loading' ? (
                            <Skeleton height={48} />
                          ) : transcript.status === 'error' ? (
                            <ErrorState compact title="We couldn't load this conversation" onRetry={() => void toggle(conversation)} />
                          ) : (
                            transcript.messages.map((m) => (
                              <AiMessage key={m.id} role={m.role} timestamp={formatAiInstant(m.createdAt)}>
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
                Load more
              </Button>
            ) : null}
          </>
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        title={pending?.kind === 'all' ? 'Clear your conversation history?' : 'Delete this conversation?'}
        description={
          pending?.kind === 'all'
            ? 'Every saved conversation and its messages will be deleted. Your remembered preferences and your AI activity history are kept, and bookings and requests stay under their own records.'
            : 'This conversation and its messages will be deleted. Your remembered preferences and your AI activity history are kept.'
        }
        confirmLabel={pending?.kind === 'all' ? 'Clear history' : 'Delete'}
        pending={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPending(null)}
      />
    </main>
  );
}
