// @vitest-environment jsdom
/** Spec 034 §5 — the conversations page: loading, empty, error, success, view, search, delete, clear (AC-8). */
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiConversationSummaryDto } from '@/lib/types/ai-assistant';
import AiConversationsPage from './page';

configure({ asyncUtilTimeout: 10_000 });

const CONVERSATIONS: AiConversationSummaryDto[] = [
  { id: 'c-1', preview: 'Need a plumber in DHA', createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:05:00.000Z' },
  { id: 'c-2', preview: 'AC not cooling', createdAt: '2026-09-19T10:00:00.000Z', updatedAt: '2026-09-19T10:05:00.000Z' },
];

type Handler = (url: string, method: string) => { status: number; body?: unknown } | undefined;

function stub(handler: Handler = () => undefined) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      const custom = handler(url, method);
      const reply =
        custom ??
        (url.startsWith('/api/v1/ai/conversations?')
          ? { status: 200, body: { data: CONVERSATIONS, page: { nextOffset: null } } }
          : url.includes('/messages')
            ? {
                status: 200,
                body: {
                  data: [
                    { id: 'm1', role: 'user', body: 'Need a plumber in DHA', createdAt: '2026-09-20T10:00:00.000Z' },
                    { id: 'm2', role: 'assistant', body: 'Here are three.', createdAt: '2026-09-20T10:00:01.000Z' },
                  ],
                  page: { nextOffset: null },
                },
              }
            : method === 'DELETE'
              ? { status: 204 }
              : { status: 500, body: { code: 'INTERNAL_ERROR', message: 'x' } });
      return { ok: reply.status < 400, status: reply.status, json: async () => reply.body ?? {} };
    }),
  );
  return calls;
}

describe('AiConversationsPage (spec 034 §5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows a loading state, then the list', async () => {
    stub();
    render(<AiConversationsPage />);
    expect(screen.getByTestId('ai-conversations-loading')).toBeInTheDocument();
    expect(await screen.findByText('Need a plumber in DHA')).toBeInTheDocument();
    expect(screen.getByText('AC not cooling')).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    stub((url) => (url.startsWith('/api/v1/ai/conversations?') ? { status: 200, body: { data: [], page: { nextOffset: null } } } : undefined));
    render(<AiConversationsPage />);
    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
  });

  it('shows the error state with retry', async () => {
    stub((url) => (url.startsWith('/api/v1/ai/conversations?') ? { status: 500, body: { code: 'INTERNAL_ERROR' } } : undefined));
    render(<AiConversationsPage />);
    expect(await screen.findByText("We couldn't load your conversations")).toBeInTheDocument();
  });

  it('views a transcript', async () => {
    stub();
    const user = userEvent.setup();
    render(<AiConversationsPage />);
    const [view] = await screen.findAllByRole('button', { name: 'View' });
    await user.click(view!);
    const transcript = await screen.findByRole('region', { name: 'Conversation transcript' });
    expect(await within(transcript).findByText('Here are three.')).toBeInTheDocument();
  });

  it('searches with q', async () => {
    const calls = stub();
    const user = userEvent.setup();
    render(<AiConversationsPage />);
    await screen.findByText('Need a plumber in DHA');
    await user.type(screen.getByRole('searchbox', { name: 'Search your conversations' }), 'plumber');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('q=plumber'))).toBe(true));
  });

  it('deletes one conversation only after confirming in the dialog', async () => {
    const calls = stub();
    const user = userEvent.setup();
    render(<AiConversationsPage />);
    await user.click(await screen.findByRole('button', { name: 'Delete conversation "Need a plumber in DHA"' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/remembered preferences and your AI activity history are kept/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/ai/conversations/c-1')).toBe(true));
    await waitFor(() => expect(screen.queryByText('Need a plumber in DHA')).not.toBeInTheDocument());
  });

  it('clear history states memory and activity are kept, then empties the list', async () => {
    const calls = stub();
    const user = userEvent.setup();
    render(<AiConversationsPage />);
    await user.click(await screen.findByRole('button', { name: 'Clear history' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/remembered preferences and your AI activity history are kept/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Clear history' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/ai/conversations')).toBe(true));
    expect(await screen.findByText('No conversations yet')).toBeInTheDocument();
  });
});
