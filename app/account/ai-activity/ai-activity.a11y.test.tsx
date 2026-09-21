// @vitest-environment jsdom
/**
 * Spec 034 §5 "Accessibility" — the activity page: one h1, labelled sections, result / risk tier /
 * confirmation conveyed in TEXT (never colour alone), and a keyboard-reachable recovery link per entry.
 */
import { configure, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AiActivityPage from './page';

configure({ asyncUtilTimeout: 10_000 });

const DATA = [
  {
    id: 'a-1',
    conversationId: 'c',
    actionLabel: 'Sent a message to Ali',
    riskTier: 'medium',
    requiredConfirmation: true,
    result: 'failed',
    related: { type: 'booking', id: 'b-1' },
    reversible: false,
    createdAt: '2026-09-20T16:32:00.000Z',
  },
  {
    id: 'a-2',
    conversationId: 'c',
    actionLabel: 'Checked availability',
    riskTier: 'low',
    requiredConfirmation: false,
    result: 'pending',
    related: { type: 'request', id: 'r-1' },
    reversible: false,
    createdAt: '2026-09-20T16:30:00.000Z',
  },
];

describe('AiActivityPage accessibility (spec 034 §5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('has one h1 and a labelled section, and marks itself busy while loading', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: DATA, page: { nextOffset: null } }) })));
    render(<AiActivityPage />);
    expect(screen.getByRole('region', { name: 'Ask Apuriva activity' })).toHaveAttribute('aria-busy', 'true');
    await screen.findByText('Sent a message to Ali');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Ask Apuriva activity' })).toHaveAttribute('aria-busy', 'false');
  });

  it('conveys result, risk tier and confirmation in text, never by colour alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: DATA, page: { nextOffset: null } }) })));
    render(<AiActivityPage />);
    expect(await screen.findByText(/Didn.t complete · Medium risk · Needed your confirmation/)).toBeInTheDocument();
    expect(screen.getAllByText('Outcome unknown').length).toBeGreaterThan(0);
    expect(screen.getByText(/Low risk · No confirmation needed/)).toBeInTheDocument();
  });

  it('every recovery link is a real, keyboard-reachable link', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: DATA, page: { nextOffset: null } }) })));
    const user = userEvent.setup();
    render(<AiActivityPage />);
    await screen.findByText('Sent a message to Ali');
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href')).sort()).toEqual(['/bookings/b-1', '/requests/r-1']);
    await user.tab();
    expect(links).toContain(document.activeElement);
  });
});
