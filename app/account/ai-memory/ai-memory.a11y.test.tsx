// @vitest-environment jsdom
/**
 * Spec 034 §5 "Accessibility" — the memory page: labelled regions, a labelled switch whose state is
 * exposed through `aria-checked`, delete controls whose accessible names say WHAT they forget, and a
 * polite live region announcing changes without moving focus.
 */
import { configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AiMemoryPage from './page';

configure({ asyncUtilTimeout: 10_000 });

function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url === '/api/v1/ai/memory' && method === 'GET')
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: 'mem-1', key: 'language', value: { language: 'en' }, valueSummary: 'English', createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:00.000Z' },
            ],
          }),
        };
      if (method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) };
      if (url === '/api/v1/users/me/ai-preferences' && method === 'GET')
        return { ok: true, status: 200, json: async () => ({ data: { proactiveSuggestionsEnabled: false } }) };
      return { ok: true, status: 200, json: async () => ({ data: JSON.parse(String(init?.body ?? '{}')) }) };
    }),
  );
}

describe('AiMemoryPage accessibility (spec 034 §5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('exposes labelled regions and one h1', async () => {
    stub();
    render(<AiMemoryPage />);
    await screen.findByText('Language — English');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Ask Apuriva memory' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Suggestions' })).toBeInTheDocument();
  });

  it('the toggle is a labelled switch whose state is in aria-checked, operable by keyboard', async () => {
    stub();
    const user = userEvent.setup();
    render(<AiMemoryPage />);
    const toggle = await screen.findByRole('switch', { name: /Proactive suggestions from Ask Apuriva/ });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    toggle.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('switch', { name: /Proactive suggestions/ })).toHaveAttribute('aria-checked', 'true'));
  });

  it('delete controls say what they forget, and the change is announced politely without moving focus', async () => {
    stub();
    const user = userEvent.setup();
    render(<AiMemoryPage />);
    const forget = await screen.findByRole('button', { name: 'Forget Language' });
    await user.click(forget);
    const status = screen.getAllByRole('status').find((el) => el.getAttribute('aria-live') === 'polite')!;
    await waitFor(() => expect(status).toHaveTextContent('Language forgotten.'));
  });
});
