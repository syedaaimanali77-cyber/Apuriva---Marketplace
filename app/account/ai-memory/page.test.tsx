// @vitest-environment jsdom
/** Spec 034 §5 — the memory page: view, delete, reset (dialog), the proactive-suggestions toggle (AC-3, AC-9). */
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiMemoryItemDto } from '@/lib/types/ai-assistant';
import AiMemoryPage from './page';

configure({ asyncUtilTimeout: 10_000 });

const ITEMS: AiMemoryItemDto[] = [
  {
    id: 'mem-1',
    key: 'preferred_area',
    value: { city: 'Lahore', area: 'DHA' },
    valueSummary: 'DHA, Lahore',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
  },
  {
    id: 'mem-2',
    key: 'language',
    value: { language: 'ur-Latn' },
    valueSummary: 'Roman Urdu',
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
  },
];

function stub(options: { items?: AiMemoryItemDto[]; memoryStatus?: number; patchStatus?: number } = {}) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      let reply: { status: number; body?: unknown } = { status: 500, body: {} };
      if (url === '/api/v1/ai/memory' && method === 'GET') reply = { status: options.memoryStatus ?? 200, body: { data: options.items ?? ITEMS } };
      else if (url.startsWith('/api/v1/ai/memory') && method === 'DELETE') reply = { status: 204 };
      else if (url === '/api/v1/users/me/ai-preferences' && method === 'GET') reply = { status: 200, body: { data: { proactiveSuggestionsEnabled: true } } };
      else if (url === '/api/v1/users/me/ai-preferences' && method === 'PATCH')
        reply = { status: options.patchStatus ?? 200, body: { data: body } };
      return { ok: reply.status < 400, status: reply.status, json: async () => reply.body ?? {} };
    }),
  );
  return calls;
}

describe('AiMemoryPage (spec 034 §5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists each entry with its plain-language label and value summary', async () => {
    stub();
    render(<AiMemoryPage />);
    expect(screen.getByTestId('ai-memory-loading')).toBeInTheDocument();
    expect(await screen.findByText('Preferred area — DHA, Lahore')).toBeInTheDocument();
    expect(screen.getByText('Language — Roman Urdu')).toBeInTheDocument();
  });

  it('the empty state explains memory holds only confirmed preferences', async () => {
    stub({ items: [] });
    render(<AiMemoryPage />);
    expect(await screen.findByText(/only remembers preferences you confirm/)).toBeInTheDocument();
  });

  it('shows the error state', async () => {
    stub({ memoryStatus: 500 });
    render(<AiMemoryPage />);
    expect(await screen.findByText("We couldn't load your memory")).toBeInTheDocument();
  });

  it('offers no way to add a memory entry', async () => {
    stub();
    render(<AiMemoryPage />);
    await screen.findByText('Preferred area — DHA, Lahore');
    expect(screen.queryByRole('button', { name: /add|remember/i })).not.toBeInTheDocument();
  });

  it('deletes one entry', async () => {
    const calls = stub();
    const user = userEvent.setup();
    render(<AiMemoryPage />);
    await user.click(await screen.findByRole('button', { name: 'Forget Preferred area' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/ai/memory/mem-1')).toBe(true));
    await waitFor(() => expect(screen.queryByText('Preferred area — DHA, Lahore')).not.toBeInTheDocument());
  });

  it('reset asks first, says conversations are unaffected, then clears', async () => {
    const calls = stub();
    const user = userEvent.setup();
    render(<AiMemoryPage />);
    await user.click(await screen.findByRole('button', { name: 'Reset memory' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Your conversations are unaffected/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reset memory' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/ai/memory')).toBe(true));
    expect(await screen.findByText('Nothing remembered yet')).toBeInTheDocument();
  });

  it('the proactive-suggestions toggle saves, and restores itself on failure', async () => {
    const calls = stub({ patchStatus: 500 });
    const user = userEvent.setup();
    render(<AiMemoryPage />);
    const toggle = await screen.findByRole('switch', { name: /Proactive suggestions from Ask Apuriva/ });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/Booking, payment and security notifications are unaffected/)).toBeInTheDocument();
    await user.click(toggle);
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ proactiveSuggestionsEnabled: false }));
    expect(await screen.findByText(/the setting was restored/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Proactive suggestions/ })).toHaveAttribute('aria-checked', 'true');
  });
});
