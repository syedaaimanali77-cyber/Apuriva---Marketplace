'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, EmptyState, ErrorState, Skeleton } from '@/components';
import { RequestMessageThread } from '@/app/_components/RequestMessageThread';
import { DELTA_READ_LIMIT, LIVE_UPDATE_INTERVAL_MS, MESSAGE_BODY_MAX_LENGTH, POLL_MAX_BACKOFF_MS } from '@/lib/messaging/limits';
import type { ConversationDto, ConversationParticipantRole, MessageDto } from '@/lib/types/messaging';
import { apiFetch, mutateHeaders } from '../booking-client';
import styles from '../bookings.module.css';

/** How often the conversation summary (read markers, active state) is refreshed — far below the message poll. */
export const CONVERSATION_SUMMARY_REFRESH_MS = 30_000;

const LIVE = { intervalMs: LIVE_UPDATE_INTERVAL_MS, deltaLimit: DELTA_READ_LIMIT, maxBackoffMs: POLL_MAX_BACKOFF_MS } as const;
const CLOSED_CODES = ['CONVERSATION_ARCHIVED'] as const;
const BLOCKED_CODES = ['BLOCKED'] as const;

const PRE_CONFIRMATION_GUIDANCE = 'Phone numbers and emails are hidden until this booking is confirmed.';

function isConversationDto(value: unknown): value is ConversationDto {
  return typeof value === 'object' && value !== null && Array.isArray((value as ConversationDto).participants);
}

export interface BookingConversationProps {
  bookingId: string;
  viewerRole: ConversationParticipantRole;
}

/**
 * Spec 025 §5 — the booking conversation, embedded in the existing booking detail pages (customer and
 * provider). A thin wrapper: spec 019's `RequestMessageThread` does all rendering and sending, driven here
 * by the booking-scoped endpoints and spec 025's 5-second cursor-delta polling.
 *
 * Nothing is optimistic: a message appears only from a server response, and a failed send keeps the draft
 * AND its `Idempotency-Key`. A blocked sender keeps the whole history. New counterparty messages are
 * announced once, as a polite aggregate. No new design-system component and no logo (CLAUDE.md branding).
 */
export function BookingConversation({ bookingId, viewerRole }: BookingConversationProps) {
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [conversation, setConversation] = useState<ConversationDto | null>(null);
  const [threadMessages, setThreadMessages] = useState<MessageDto[]>([]);
  const lastMarkedRef = useRef<string | null>(null);
  const base = `/api/v1/bookings/${encodeURIComponent(bookingId)}/conversation`;

  /** Whether the summary is worth refreshing: only an ACTIVE conversation's read markers can still change. */
  const summaryLiveRef = useRef(true);

  const loadSummary = useCallback(async () => {
    // A network failure rejects rather than answering with an error envelope; it must land in the error
    // state (with retry), never leave the card on its loading skeleton or surface as an unhandled rejection.
    const result = await apiFetch<ConversationDto>(base).catch(() => null);
    if (result?.ok && isConversationDto(result.data)) {
      setConversation(result.data);
      summaryLiveRef.current = result.data.isActive;
      setStatus('ready');
      return;
    }
    // An endpoint that is not answering usefully will not start doing so because we keep asking (the
    // same rule spec 022's RefundSection follows): stop refreshing, and leave the retry to the viewer.
    summaryLiveRef.current = false;
    setStatus((current) => (current === 'ready' ? current : 'error'));
  }, [base]);

  useEffect(() => {
    summaryLiveRef.current = true;
    void loadSummary();
    const timer = setInterval(() => {
      if (summaryLiveRef.current && document.visibilityState !== 'hidden') void loadSummary();
    }, CONVERSATION_SUMMARY_REFRESH_MS);
    return () => clearInterval(timer);
  }, [loadSummary]);

  /** Advances this participant's read marker to the newest counterparty message, once per message. */
  const markRead = useCallback(
    async (messages: MessageDto[]) => {
      if (conversation === null || !conversation.isActive || document.visibilityState === 'hidden') return;
      const newest = [...messages].reverse().find((message) => message.senderRole !== viewerRole);
      if (!newest || newest.id === lastMarkedRef.current) return;
      lastMarkedRef.current = newest.id;
      const result = await apiFetch(`${base}/read`, {
        method: 'POST',
        headers: mutateHeaders(),
        body: JSON.stringify({ lastReadMessageId: newest.id }),
      }).catch(() => null);
      // Not recorded: the next poll or visibility change tries this message again.
      if (!result?.ok) lastMarkedRef.current = null;
    },
    [base, conversation, viewerRole],
  );

  // Messages that arrived while the tab was hidden are marked read when the viewer comes back to it.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') void markRead(threadMessages);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [markRead, threadMessages]);

  if (status === 'loading') {
    return (
      <Card>
        <h2 className={styles.sectionTitle}>Messages</h2>
        <Skeleton lines={3} />
      </Card>
    );
  }

  if (status === 'error' || conversation === null) {
    return (
      <Card>
        <h2 className={styles.sectionTitle}>Messages</h2>
        <ErrorState
          description="Couldn't load this conversation."
          onRetry={() => {
            summaryLiveRef.current = true;
            void loadSummary();
          }}
        />
      </Card>
    );
  }

  const counterparty = conversation.participants.find((participant) => participant.role !== viewerRole);
  const counterpartyLabel = counterparty?.displayName ?? (viewerRole === 'customer' ? 'Your provider' : 'Your customer');
  const counterpartyReadAt = counterparty?.lastReadAt ?? null;
  // §5: read state is ONE quiet timestamp on the viewer's own last message the counterparty has read.
  const lastSeenOwn =
    counterpartyReadAt === null
      ? undefined
      : [...threadMessages].reverse().find((message) => message.senderRole === viewerRole && message.createdAt <= counterpartyReadAt);

  const guidance = conversation.contactSharingAllowed
    ? 'Keep your conversation on APURIVA so there is a record if you need support.'
    : PRE_CONFIRMATION_GUIDANCE;

  return (
    <Card>
      <h2 className={styles.sectionTitle}>Messages</h2>
      <RequestMessageThread<MessageDto>
        listUrl={`${base}/messages`}
        postUrl={`${base}/messages`}
        viewerRole={viewerRole}
        counterpartyLabel={counterpartyLabel}
        canSend={conversation.isActive}
        closedMessage="This booking has ended, so this conversation is read-only. You can still read it."
        blockedMessage="You can no longer send messages in this conversation. You can still read it, and our support team can still help."
        emptyContent={<EmptyState compact title="No messages yet — say hello" description={guidance} />}
        composerHelp={guidance}
        maxLength={MESSAGE_BODY_MAX_LENGTH}
        redactionNotice="We hid a phone number or email in your message. You can share contact details once this booking is confirmed."
        closedCodes={CLOSED_CODES}
        blockedCodes={BLOCKED_CODES}
        retainKeyOnFailure
        live={LIVE}
        announceIncoming
        onMessages={(messages) => {
          setThreadMessages(messages);
          void markRead(messages);
        }}
        renderMessageMeta={(message) =>
          lastSeenOwn && message.id === lastSeenOwn.id && counterpartyReadAt ? (
            <span className={styles.hint}>Seen {new Date(counterpartyReadAt).toLocaleString()}</span>
          ) : null
        }
      />
    </Card>
  );
}
