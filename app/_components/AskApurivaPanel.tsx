'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AiAssistantLauncher, AiAssistantPanel } from '@/components/AiAssistantPanel';
import { AiConfirmationCard } from '@/components/AiConfirmationCard';
import { AiMessage } from '@/components/AiMessage';
import { AiSuggestedActions } from '@/components/AiSuggestedActions';
import { AiToolApproval } from '@/components/AiToolApproval';
import { ErrorState } from '@/components/ErrorState';
import { Switch } from '@/components/Switch';
import { useAuthGate } from '@/lib/auth-gate/use-auth-gate';
import { AI_MEMORY_KEY_LABELS } from '@/lib/ai-assistant/labels';
import type {
  AiActionDto,
  AiConversationDto,
  AiMemoryProposalDto,
  AiMessageDto,
  AiMessageRole,
  AiPendingConfirmationDto,
  AiProactiveSuggestionDto,
  AiTemporaryReplyDto,
} from '@/lib/types/ai-assistant';
import { aiMutation, isAiUnavailable, newIdempotencyKey, readAiResponse, type AiApiResult } from './ask-apuriva-client';
import styles from './ask-apuriva.module.css';

/** §5 — fixed starter prompts. They only PRE-FILL the composer; they are not proactive suggestions. */
export const STARTER_PROMPTS = ['Find a service near me', 'Help me describe what I need', 'How does booking work?'];

export const UNAVAILABLE_MESSAGE = 'Ask Apuriva is temporarily unavailable — try search directly.';
const TEMPORARY_NOTICE = 'Not saved, not used to remember preferences, cannot take actions, and disappears when closed.';

type ApprovalState = 'pending' | 'approved' | 'denied' | 'failed';

interface PanelMessage {
  key: string;
  role: AiMessageRole;
  body: string;
  memoryProposal?: AiMemoryProposalDto;
  memoryState?: ApprovalState;
  pendingConfirmation?: AiPendingConfirmationDto;
  confirmState?: ApprovalState | 'busy';
  confirmResult?: AiActionDto['result'];
}

const RESULT_TEXT: Record<AiActionDto['result'], string> = {
  succeeded: 'Completed.',
  failed: "Didn't complete.",
  pending: 'Outcome unknown — check your AI activity.',
};

export interface AskApurivaPanelProps {
  onClose: () => void;
}

/**
 * Spec 034 §5 — the open Ask Apuriva panel, composed from the design system's AI primitives.
 *
 * NORMAL mode starts a stored conversation on the first message. TEMPORARY mode (a `Switch` offered
 * only before a conversation starts) keeps the transcript in this component's state ONLY — never in
 * `localStorage`/`sessionStorage`/IndexedDB — sends it whole to the stateless temporary-turn route,
 * renders no memory proposal and no action confirmation, and discards everything when closed.
 *
 * Proactive suggestions render in the footer as "Ask Apuriva suggests"; selecting one only
 * navigates. A guest is routed through spec 007's AuthGate on the first `401`.
 */
export function AskApurivaPanel({ onClose }: AskApurivaPanelProps) {
  const router = useRouter();
  const { guard } = useAuthGate();

  const [temporary, setTemporary] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<{ kind: 'unavailable' | 'error'; retryText: string } | null>(null);
  const [suggestions, setSuggestions] = useState<AiProactiveSuggestionDto[]>([]);
  const keyCounter = useRef(0);

  const nextKey = () => {
    keyCounter.current += 1;
    return `m${keyCounter.current}`;
  };

  // Suggestions are PULLED once, when the panel opens (§3.10). A failure renders nothing.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { redirectedToAuth, response } = await guard({ actionType: 'ask-apuriva' }, () =>
        fetch('/api/v1/ai/suggestions', { credentials: 'same-origin' }),
      );
      if (redirectedToAuth || cancelled) return;
      const result = await readAiResponse<AiProactiveSuggestionDto[]>(response);
      if (!cancelled && result.ok) setSuggestions(result.data ?? []);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Runs once per opened panel; `guard` is re-created each render and must not re-trigger it.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const guarded = useCallback(
    async <T,>(run: () => Promise<Response>): Promise<AiApiResult<T> | null> => {
      try {
        const { redirectedToAuth, response } = await guard({ actionType: 'ask-apuriva' }, run);
        if (redirectedToAuth) return null;
        return await readAiResponse<T>(response);
      } catch {
        return { ok: false, status: 0, error: { code: 'NETWORK_ERROR', message: 'We could not reach the server.' } };
      }
    },
    [guard],
  );

  async function ensureConversation(retryText: string): Promise<string | null> {
    if (conversationId) return conversationId;
    const key = newIdempotencyKey();
    const created = await guarded<AiConversationDto>(() => fetch('/api/v1/ai/conversations', aiMutation('POST', {}, key)));
    if (!created) return null;
    if (!created.ok || !created.data) {
      setFailure({ kind: isAiUnavailable(created.error) ? 'unavailable' : 'error', retryText });
      return null;
    }
    setConversationId(created.data.id);
    return created.data.id;
  }

  async function send(raw?: string) {
    const text = (raw ?? composer).trim();
    if (text.length === 0 || sending) return;
    setFailure(null);
    setSending(true);
    const userMessage: PanelMessage = { key: nextKey(), role: 'user', body: text };
    const transcript = [...messages, userMessage];
    setMessages(transcript);
    setComposer('');

    if (temporary) {
      const turns = transcript.map((m) => ({ role: m.role, body: m.body }));
      const res = await guarded<AiTemporaryReplyDto>(() => fetch('/api/v1/ai/temporary-turns', aiMutation('POST', { turns })));
      setSending(false);
      if (!res) return;
      if (!res.ok || !res.data) {
        // The temporary transcript so far stays on screen; only the unanswered turn is withdrawn.
        setMessages(messages);
        setFailure({ kind: isAiUnavailable(res.error) ? 'unavailable' : 'error', retryText: text });
        return;
      }
      setMessages([...transcript, { key: nextKey(), role: 'assistant', body: res.data.body }]);
      return;
    }

    const id = await ensureConversation(text);
    if (!id) {
      setSending(false);
      setMessages(messages);
      return;
    }
    const res = await guarded<AiMessageDto>(() =>
      fetch(`/api/v1/ai/conversations/${encodeURIComponent(id)}/messages`, aiMutation('POST', { body: text }, newIdempotencyKey())),
    );
    setSending(false);
    if (!res) return;
    if (!res.ok || !res.data) {
      // Nothing was stored for a failed turn (§3.3 step 4), so it is withdrawn here too.
      setMessages(messages);
      setFailure({ kind: isAiUnavailable(res.error) ? 'unavailable' : 'error', retryText: text });
      return;
    }
    const reply = res.data;
    setMessages([
      ...transcript,
      {
        key: nextKey(),
        role: 'assistant',
        body: reply.body,
        memoryProposal: reply.memoryProposal,
        memoryState: reply.memoryProposal ? 'pending' : undefined,
        pendingConfirmation: reply.pendingConfirmation,
        confirmState: reply.pendingConfirmation ? 'pending' : undefined,
      },
    ]);
  }

  function patchMessage(key: string, patch: Partial<PanelMessage>) {
    setMessages((current) => current.map((m) => (m.key === key ? { ...m, ...patch } : m)));
  }

  /** The user's EXPLICIT confirmation of a memory proposal — the only way memory is ever written. */
  async function rememberProposal(message: PanelMessage) {
    if (!message.memoryProposal || !conversationId) return;
    const { key, value } = message.memoryProposal;
    const res = await guarded(() => fetch('/api/v1/ai/memory', aiMutation('POST', { conversationId, key, value })));
    if (!res) return;
    patchMessage(message.key, { memoryState: res.ok ? 'approved' : 'failed' });
  }

  /** The user's EXPLICIT confirmation of a medium/high action — never inferred from message text. */
  async function confirmAction(message: PanelMessage) {
    if (!message.pendingConfirmation || !conversationId) return;
    patchMessage(message.key, { confirmState: 'busy' });
    const res = await guarded<AiActionDto>(() =>
      fetch(
        `/api/v1/ai/conversations/${encodeURIComponent(conversationId)}/confirm`,
        aiMutation('POST', { confirmationId: message.pendingConfirmation!.confirmationId }, newIdempotencyKey()),
      ),
    );
    if (!res) return;
    if (!res.ok || !res.data) {
      patchMessage(message.key, { confirmState: 'failed' });
      return;
    }
    patchMessage(message.key, { confirmState: 'approved', confirmResult: res.data.result });
  }

  const started = messages.length > 0;

  return (
    <AiAssistantPanel
      title={temporary ? 'Ask Apuriva — temporary conversation' : 'Ask Apuriva'}
      subtitle={temporary ? TEMPORARY_NOTICE : undefined}
      composerValue={composer}
      onComposerChange={(e) => setComposer(e.target.value)}
      onSend={() => void send()}
      onClose={onClose}
      footer={
        suggestions.length > 0 ? (
          <div className={styles.suggestions}>
            <AiSuggestedActions
              label="Ask Apuriva suggests"
              actions={suggestions.map((s) => ({ id: `${s.link.type}:${s.link.id}`, label: s.text }))}
              onSelect={(action) => {
                const suggestion = suggestions.find((s) => `${s.link.type}:${s.link.id}` === action.id);
                if (!suggestion) return;
                // Navigation ONLY — a suggestion never performs an action (AC-15).
                router.push(suggestion.link.type === 'booking' ? `/bookings/${suggestion.link.id}` : `/requests/${suggestion.link.id}`);
              }}
            />
          </div>
        ) : undefined
      }
    >
      {!started ? (
        <>
          <div className={styles.modeRow}>
            <Switch
              label="Temporary conversation"
              description="Not saved to your history and never used to remember preferences."
              checked={temporary}
              onChange={(next) => setTemporary(next)}
            />
          </div>
          <AiSuggestedActions label="Try asking" actions={STARTER_PROMPTS} onSelect={(action) => setComposer(action.label)} />
        </>
      ) : null}

      {messages.map((message) => (
        <div key={message.key} className={styles.turn}>
          <AiMessage role={message.role}>{message.body}</AiMessage>

          {!temporary && message.memoryProposal && message.memoryState ? (
            <AiToolApproval
              toolLabel="Remember this preference"
              args={[{ label: AI_MEMORY_KEY_LABELS[message.memoryProposal.key], value: message.memoryProposal.valueSummary }]}
              state={message.memoryState}
              errorMessage="We couldn't save that preference. Nothing was remembered."
              onApprove={() => void rememberProposal(message)}
              onDeny={() => patchMessage(message.key, { memoryState: 'denied' })}
            />
          ) : null}

          {!temporary && message.pendingConfirmation ? (
            message.confirmResult ? (
              <p className={styles.status}>
                {message.pendingConfirmation.actionLabel}: {RESULT_TEXT[message.confirmResult]}
              </p>
            ) : message.pendingConfirmation.riskTier === 'high' ? (
              message.confirmState === 'denied' ? (
                <p className={styles.status}>{message.pendingConfirmation.actionLabel}: not confirmed. Nothing was done.</p>
              ) : (
                <AiConfirmationCard
                  title={message.pendingConfirmation.actionLabel}
                  riskLevel="high"
                  parameters={message.pendingConfirmation.parameters}
                  busy={message.confirmState === 'busy'}
                  onConfirm={() => void confirmAction(message)}
                  onCancel={() => patchMessage(message.key, { confirmState: 'denied' })}
                />
              )
            ) : (
              <AiToolApproval
                toolLabel={message.pendingConfirmation.actionLabel}
                args={message.pendingConfirmation.parameters}
                state={message.confirmState === 'busy' ? 'pending' : (message.confirmState ?? 'pending')}
                errorMessage="That didn't go through. Nothing was done — you can ask again."
                onApprove={() => void confirmAction(message)}
                onDeny={() => patchMessage(message.key, { confirmState: 'denied' })}
              />
            )
          ) : null}
        </div>
      ))}

      {sending ? <AiMessage role="assistant" pending /> : null}

      {failure ? (
        failure.kind === 'unavailable' ? (
          <p role="status" className={styles.status}>
            {UNAVAILABLE_MESSAGE}
          </p>
        ) : (
          <ErrorState
            compact
            title="That message didn't send"
            description="Nothing was saved. Try again."
            onRetry={failure.retryText ? () => void send(failure.retryText) : undefined}
          />
        )
      ) : null}
    </AiAssistantPanel>
  );
}

/**
 * Spec 034 §5 — the contextual launcher plus the panel it opens. Closing ends the session: a
 * temporary transcript is discarded with the component state, and the next open starts afresh.
 */
export function AskApuriva() {
  const [open, setOpen] = useState(false);
  return open ? (
    <div className={styles.panel}>
      <AskApurivaPanel onClose={() => setOpen(false)} />
    </div>
  ) : (
    <div className={styles.launcher}>
      <AiAssistantLauncher onClick={() => setOpen(true)} />
    </div>
  );
}
