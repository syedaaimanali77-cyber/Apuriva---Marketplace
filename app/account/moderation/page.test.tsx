// @vitest-environment jsdom
/** Spec 038 §5 — the affected user's view: standard explanations, the admin's optional message, the appeal. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AccountModerationPage from './page';

const ACTION = {
  id: 'action-1',
  actionType: 'suspension',
  scope: 'account',
  status: 'active',
  userMessage: 'Please use the appeal form.',
  activatedAt: '2026-09-01T10:00:00.000Z',
  appealable: true,
  appeal: null,
};

function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift() ?? { body: { data: [] } };
    const status = next.status ?? 200;
    return { status, ok: status < 400, json: async () => next.body } as unknown as Response;
  });
}

describe('AccountModerationPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.cookie = 'apuriva_csrf=test';
  });

  it('renders loading, error and good-standing states', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { container, unmount } = render(<AccountModerationPage />);
    expect(container.querySelector('main')).toBeInTheDocument();
    unmount();

    vi.stubGlobal('fetch', stubFetch([{ status: 500, body: { code: 'INTERNAL_ERROR', message: 'Oops.' } }]));
    const second = render(<AccountModerationPage />);
    expect(await screen.findByText('Moderation unavailable')).toBeInTheDocument();
    second.unmount();

    vi.stubGlobal('fetch', stubFetch([{ body: { data: [] } }]));
    render(<AccountModerationPage />);
    expect(await screen.findByText('Your account is in good standing')).toBeInTheDocument();
  });

  it('explains the action, shows the shared message, and files an appeal with an Idempotency-Key', async () => {
    const fetchMock = stubFetch([
      { body: { data: [ACTION] } },
      { status: 201, body: { data: { id: 'appeal-1', status: 'pending' } } },
      { body: { data: [{ ...ACTION, appealable: false, appeal: { status: 'pending', decidedAt: null } }] } },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<AccountModerationPage />);

    expect(await screen.findByText(/Your account is suspended/)).toBeInTheDocument();
    expect(screen.getByText(/Please use the appeal form\./)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Appeal this decision' }));
    expect(screen.getByRole('button', { name: 'Send appeal' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/why this decision/), 'I did nothing wrong.');
    await userEvent.click(screen.getByRole('button', { name: 'Send appeal' }));

    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/moderation-actions/action-1/appeals');
    expect(JSON.parse(init.body as string)).toEqual({ statement: 'I did nothing wrong.' });
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    expect(await screen.findByText(/Your appeal was sent/)).toBeInTheDocument();
    expect(screen.getByText('Appeal: pending')).toBeInTheDocument();
  });

  it('keeps the statement when sending fails', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([{ body: { data: [ACTION] } }, { status: 409, body: { code: 'APPEAL_ALREADY_FILED', message: 'An appeal has already been filed for this action.' } }]),
    );
    render(<AccountModerationPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Appeal this decision' }));
    await userEvent.type(screen.getByLabelText(/why this decision/), 'Second try.');
    await userEvent.click(screen.getByRole('button', { name: 'Send appeal' }));
    expect(await screen.findByText('An appeal has already been filed for this action.')).toBeInTheDocument();
    expect(screen.getByLabelText(/why this decision/)).toHaveValue('Second try.');
  });
});
