// @vitest-environment jsdom
/**
 * Spec 034 §5 — the Ask Apuriva panel: normal and temporary modes, the memory-proposal and
 * confirmation cards, proactive suggestions, and the failure states (AC-9, AC-13, AC-14, AC-15, AC-18).
 */
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiMessageDto, AiProactiveSuggestionDto } from '@/lib/types/ai-assistant';
import { AskApuriva, AskApurivaPanel, STARTER_PROMPTS, UNAVAILABLE_MESSAGE } from './AskApurivaPanel';

configure({ asyncUtilTimeout: 10_000 });

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/explore/cat/svc',
}));

const SUGGESTIONS: AiProactiveSuggestionDto[] = [
  { kind: 'upcoming_booking', source: 'ask_apuriva', text: 'Ask Apuriva suggests reviewing your upcoming booking.', link: { type: 'booking', id: 'b-1' } },
];

type Reply = { status: number; body: unknown };
type Calls = Array<{ url: string; method: string; body?: any; headers: Record<string, string> }>;

function stub(overrides: { suggestions?: AiProactiveSuggestionDto[]; message?: Reply; temporary?: Reply; memory?: Reply; confirm?: Reply } = {}) {
  const calls: Calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      let reply: Reply = { status: 500, body: { code: 'INTERNAL_ERROR', message: 'unexpected' } };
      if (url === '/api/v1/ai/suggestions') reply = { status: 200, body: { data: overrides.suggestions ?? [] } };
      else if (url === '/api/v1/ai/conversations' && method === 'POST') reply = { status: 201, body: { data: { id: 'conv-1' } } };
      else if (url.endsWith('/messages') && method === 'POST')
        reply = overrides.message ?? { status: 201, body: { data: { id: 'm-2', role: 'assistant', body: 'Here to help.', createdAt: '' } } };
      else if (url === '/api/v1/ai/temporary-turns') reply = overrides.temporary ?? { status: 200, body: { data: { role: 'assistant', body: 'Private reply.' } } };
      else if (url === '/api/v1/ai/memory') reply = overrides.memory ?? { status: 201, body: { data: {} } };
      else if (url.endsWith('/confirm')) reply = overrides.confirm ?? { status: 200, body: { data: { result: 'succeeded' } } };
      return {
        ok: reply.status < 400,
        status: reply.status,
        json: async () => reply.body,
        clone() {
          return this;
        },
      };
    }),
  );
  return calls;
}

async function send(text: string) {
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Message Ask Apuriva' }), text);
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

function replyWith(extra: Partial<AiMessageDto>): Reply {
  return { status: 201, body: { data: { id: 'm-2', role: 'assistant', body: 'Sure.', createdAt: '', ...extra } } };
}

describe('AskApurivaPanel (spec 034 §5)', () => {
  beforeEach(() => push.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  it('opens from the launcher and closes back to it', async () => {
    stub();
    const user = userEvent.setup();
    render(<AskApuriva />);
    await user.click(screen.getByRole('button', { name: 'Ask Apuriva' }));
    expect(screen.getByRole('region', { name: 'Ask Apuriva' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close assistant' }));
    expect(screen.queryByRole('region', { name: 'Ask Apuriva' })).not.toBeInTheDocument();
  });

  it('a normal turn starts a stored conversation, then sends the message with an Idempotency-Key', async () => {
    const calls = stub();
    render(<AskApurivaPanel onClose={() => undefined} />);
    await send('Need a plumber');
    expect(await screen.findByText('Here to help.')).toBeInTheDocument();
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.url)).toEqual(['/api/v1/ai/conversations', '/api/v1/ai/conversations/conv-1/messages']);
    expect(posts[1]!.body).toEqual({ body: 'Need a plumber' });
    expect(posts[1]!.headers['Idempotency-Key']).toBeTruthy();
  });

  it('starter prompts only pre-fill the composer; nothing is sent', async () => {
    const calls = stub();
    const user = userEvent.setup();
    render(<AskApurivaPanel onClose={() => undefined} />);
    await user.click(screen.getByRole('button', { name: STARTER_PROMPTS[0]! }));
    expect(screen.getByRole('textbox', { name: 'Message Ask Apuriva' })).toHaveValue(STARTER_PROMPTS[0]);
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('a proactive suggestion is attributed to Ask Apuriva, never rendered as a system fact, and selecting it only navigates', async () => {
    const calls = stub({ suggestions: SUGGESTIONS });
    const user = userEvent.setup();
    render(<AskApurivaPanel onClose={() => undefined} />);
    const suggestion = await screen.findByRole('button', { name: SUGGESTIONS[0]!.text });
    expect(screen.getByText('Ask Apuriva suggests')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(suggestion);
    expect(push).toHaveBeenCalledWith('/bookings/b-1');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('with no suggestions (or the preference off) nothing is rendered for them', async () => {
    stub({ suggestions: [] });
    render(<AskApurivaPanel onClose={() => undefined} />);
    await waitFor(() => expect(screen.queryByText('Ask Apuriva suggests')).not.toBeInTheDocument());
  });

  it('a memory proposal is shown for approval; deny stores nothing', async () => {
    const calls = stub({ message: replyWith({ memoryProposal: { key: 'preferred_area', value: { city: 'Lahore', area: 'DHA' }, valueSummary: 'DHA, Lahore' } }) });
    const user = userEvent.setup();
    render(<AskApurivaPanel onClose={() => undefined} />);
    await send('I live in DHA');
    expect(await screen.findByText('Remember this preference')).toBeInTheDocument();
    expect(screen.getByText('DHA, Lahore')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Don't allow" }));
    expect(calls.some((c) => c.url === '/api/v1/ai/memory')).toBe(false);
  });

  it('approving a memory proposal sends the explicit confirmation with the conversation id', async () => {
    const calls = stub({ message: replyWith({ memoryProposal: { key: 'language', value: { language: 'ur' }, valueSummary: 'Urdu' } }) });
    const user = userEvent.setup();
    render(<AskApurivaPanel onClose={() => undefined} />);
    await send('Reply in Urdu');
    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/v1/ai/memory')).toBe(true));
    expect(calls.find((c) => c.url === '/api/v1/ai/memory')!.body).toEqual({ conversationId: 'conv-1', key: 'language', value: { language: 'ur' } });
  });

  it('a high-risk proposal renders the structured card listing every bound parameter; confirm is an explicit request', async () => {
    const parameters = [
      { label: 'Provider', value: 'Ali Raza' },
      { label: 'Date', value: 'Tomorrow 10:00' },
      { label: 'Price', value: 'PKR 3,200' },
    ];
    const calls = stub({
      message: replyWith({ pendingConfirmation: { confirmationId: 'conf-1', riskTier: 'high', actionLabel: 'Book AC repair with Ali Raza', parameters } }),
    });
    const user = userEvent.setup();
    render(<AskApurivaPanel onClose={() => undefined} />);
    await send('Book it');
    const card = await screen.findByRole('region', { name: 'Action confirmation' });
    for (const p of parameters) expect(within(card).getByText(p.value)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/confirm'))).toBe(false);
    await user.click(within(card).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/confirm'))!.body).toEqual({ confirmationId: 'conf-1' }));
    expect(await screen.findByText(/Completed\./)).toBeInTheDocument();
  });

  it('temporary mode: the notice is shown, the whole transcript goes to the stateless route, and no conversation is created', async () => {
    const calls = stub();
    const user = userEvent.setup();
    render(<AskApurivaPanel onClose={() => undefined} />);
    await user.click(screen.getByRole('switch', { name: /Temporary conversation/ }));
    expect(screen.getByRole('region', { name: 'Ask Apuriva — temporary conversation' })).toBeInTheDocument();
    expect(screen.getByText(/cannot take actions, and disappears when closed/)).toBeInTheDocument();

    await send('First');
    expect(await screen.findByText('Private reply.')).toBeInTheDocument();
    await send('Second');
    await screen.findAllByText('Private reply.');

    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.every((c) => c.url === '/api/v1/ai/temporary-turns')).toBe(true);
    expect(posts[1]!.body.turns).toEqual([
      { role: 'user', body: 'First' },
      { role: 'assistant', body: 'Private reply.' },
      { role: 'user', body: 'Second' },
    ]);
    expect(posts.some((c) => c.headers['Idempotency-Key'])).toBe(false);
    // The switch is offered only before the conversation starts.
    expect(screen.queryByRole('switch', { name: /Temporary conversation/ })).not.toBeInTheDocument();
  });

  it('the temporary transcript is never written to browser storage', async () => {
    stub();
    const local = vi.spyOn(Storage.prototype, 'setItem');
    const user = userEvent.setup();
    render(<AskApurivaPanel onClose={() => undefined} />);
    await user.click(screen.getByRole('switch', { name: /Temporary conversation/ }));
    await send('secret-temporary-text');
    await screen.findByText('Private reply.');
    const written = local.mock.calls.map((args) => args.join('|')).join('\n');
    expect(written).not.toContain('secret-temporary-text');
    expect(written).not.toContain('Private reply.');
    local.mockRestore();
  });

  it('no action confirmation or memory proposal renders in temporary mode', async () => {
    stub({ temporary: { status: 200, body: { data: { role: 'assistant', body: 'Only words.' } } } });
    const user = userEvent.setup();
    render(<AskApurivaPanel onClose={() => undefined} />);
    await user.click(screen.getByRole('switch', { name: /Temporary conversation/ }));
    await send('Book it and remember me');
    await screen.findByText('Only words.');
    expect(screen.queryByRole('region', { name: 'Action confirmation' })).not.toBeInTheDocument();
    expect(screen.queryByText('Remember this preference')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('a degradable AI failure says the assistant is unavailable and withdraws the unanswered turn', async () => {
    stub({ message: { status: 503, body: { code: 'AI_PROVIDER_UNAVAILABLE', message: 'down' } } });
    render(<AskApurivaPanel onClose={() => undefined} />);
    await send('Hello?');
    expect(await screen.findByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText('Hello?')).not.toBeInTheDocument();
  });

  it('shows the pending reply as a typing indicator, never an instant fabricated answer', async () => {
    let release: () => void = () => undefined;
    const calls = stub();
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/messages')) await new Promise<void>((resolve) => (release = resolve));
        return (original as typeof fetch)(url, init);
      }),
    );
    render(<AskApurivaPanel onClose={() => undefined} />);
    await send('Slow question');
    expect(await screen.findByLabelText('Ask Apuriva is thinking')).toBeInTheDocument();
    expect(screen.queryByText('Here to help.')).not.toBeInTheDocument();
    release();
    expect(await screen.findByText('Here to help.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Ask Apuriva is thinking')).not.toBeInTheDocument();
    expect(calls.length).toBeGreaterThan(0);
  });
});
