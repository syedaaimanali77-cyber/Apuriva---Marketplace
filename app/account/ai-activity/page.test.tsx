// @vitest-environment jsdom
/** Spec 034 §5 — the activity page (AC-10, AC-11): plain language, no Undo, recovery links, pending never a success. */
import { configure, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiActionDto } from '@/lib/types/ai-assistant';
import AiActivityPage from './page';

configure({ asyncUtilTimeout: 10_000 });

function entry(overrides: Partial<AiActionDto>): AiActionDto {
  return {
    id: 'a-1',
    conversationId: 'c-1',
    actionLabel: 'Booking confirmed after your approval',
    riskTier: 'high',
    requiredConfirmation: true,
    result: 'succeeded',
    related: { type: 'booking', id: 'b-9' },
    reversible: false,
    createdAt: '2026-09-20T16:32:00.000Z',
    ...overrides,
  };
}

function stub(data: AiActionDto[] | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      data === null
        ? { ok: false, status: 500, json: async () => ({ code: 'INTERNAL_ERROR' }) }
        : { ok: true, status: 200, json: async () => ({ data, page: { nextOffset: null } }) },
    ),
  );
}

describe('AiActivityPage (spec 034 §5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows loading, then each entry in plain language with its result, tier and confirmation', async () => {
    stub([entry({}), entry({ id: 'a-2', actionLabel: 'Searched for electricians', riskTier: 'low', requiredConfirmation: false, related: { type: 'request', id: 'r-1' } })]);
    render(<AiActivityPage />);
    expect(screen.getByTestId('ai-activity-loading')).toBeInTheDocument();
    expect(await screen.findByText('Booking confirmed after your approval')).toBeInTheDocument();
    expect(screen.getByText('Searched for electricians')).toBeInTheDocument();
    expect(screen.getAllByText(/High risk · Needed your confirmation/)).toHaveLength(1);
    expect(screen.getAllByText(/Low risk · No confirmation needed/)).toHaveLength(1);
  });

  it('no Undo; explains and links the recovery path', async () => {
    stub([entry({})]);
    render(<AiActivityPage />);
    await screen.findByText('Booking confirmed after your approval');
    expect(screen.queryByRole('button', { name: /\bundo\b/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/\bundo\b/i)).not.toBeInTheDocument();
    expect(screen.getByText(/This can.t be undone here/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'booking' })).toHaveAttribute('href', '/bookings/b-9');
  });

  it('an outcome-unknown entry is never shown as a success', async () => {
    stub([entry({ id: 'a-3', actionLabel: 'Checked availability', result: 'pending', related: { type: 'request', id: 'r-2' } })]);
    render(<AiActivityPage />);
    const heading = await screen.findByRole('heading', { name: 'Outcome unknown' });
    const section = heading.closest('section')!;
    expect(within(section).getByText('Checked availability')).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'request' })).toHaveAttribute('href', '/requests/r-2');
    expect(screen.queryByText(/Completed/)).not.toBeInTheDocument();
  });

  it('shows the empty and error states', async () => {
    stub([]);
    const { unmount } = render(<AiActivityPage />);
    expect(await screen.findByText('No AI activity yet')).toBeInTheDocument();
    unmount();
    stub(null);
    render(<AiActivityPage />);
    expect(await screen.findByText("We couldn't load your AI activity")).toBeInTheDocument();
  });
});
