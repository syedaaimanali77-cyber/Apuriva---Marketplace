// @vitest-environment jsdom
/** Spec 038 §5 — the appeal queue: a structured, reasoned decision; the different-admin refusal shown plainly. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminModerationAppealsPage from './page';

const APPEAL = {
  id: 'appeal-1',
  moderationActionId: 'action-1',
  status: 'pending',
  statement: 'My account was compromised.',
  decisionReason: null,
  decidedByAdminUserId: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  decidedAt: null,
};

function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift() ?? { body: { data: [] } };
    const status = next.status ?? 200;
    return { status, ok: status < 400, json: async () => next.body } as unknown as Response;
  });
}

describe('AdminModerationAppealsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.cookie = 'apuriva_csrf=test';
  });

  it('renders loading, error and empty states', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { container, unmount } = render(<AdminModerationAppealsPage />);
    expect(container.querySelector('main')).toBeInTheDocument();
    unmount();

    vi.stubGlobal('fetch', stubFetch([{ status: 403, body: { code: 'FORBIDDEN', message: 'No.' } }]));
    const second = render(<AdminModerationAppealsPage />);
    expect(await screen.findByText('Appeal queue unavailable')).toBeInTheDocument();
    second.unmount();

    vi.stubGlobal('fetch', stubFetch([{ body: { data: [] } }]));
    render(<AdminModerationAppealsPage />);
    expect(await screen.findByText('No appeals waiting')).toBeInTheDocument();
  });

  it('requires a reason and a confirmation, then posts the decision', async () => {
    const fetchMock = stubFetch([{ body: { data: [APPEAL] } }, { body: { data: { ...APPEAL, status: 'upheld' } } }, { body: { data: [] } }]);
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminModerationAppealsPage />);

    expect(await screen.findByText('My account was compromised.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Decide' }));
    expect(screen.getByRole('button', { name: 'Review and confirm' })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Decision'), 'upheld');
    await userEvent.type(screen.getByLabelText(/Reason/), 'Compromise confirmed.');
    await userEvent.click(screen.getByRole('button', { name: 'Review and confirm' }));
    expect(screen.getByText('Uphold and reverse the action?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm decision' }));

    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/admin/moderation-appeals/appeal-1/decide');
    expect(JSON.parse(init.body as string)).toEqual({ decision: 'upheld', reason: 'Compromise confirmed.' });
  });

  it('shows the different-admin refusal', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([
        { body: { data: [APPEAL] } },
        { status: 403, body: { code: 'APPEAL_REQUIRES_DIFFERENT_ADMIN', message: 'An appeal must be decided by an admin who neither initiated nor approved the action.' } },
      ]),
    );
    render(<AdminModerationAppealsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Decide' }));
    await userEvent.type(screen.getByLabelText(/Reason/), 'Stands.');
    await userEvent.click(screen.getByRole('button', { name: 'Review and confirm' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm decision' }));
    expect(await screen.findByText(/neither initiated nor approved/)).toBeInTheDocument();
  });
});
