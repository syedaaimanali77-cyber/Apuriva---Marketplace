// @vitest-environment jsdom
/**
 * Spec 038 §5 — one account's moderation page: history, the structured confirmation with a mandatory
 * reason (never a one-click ban), "awaiting second admin", and a failed submit preserving the input.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'user-7' }),
  useSearchParams: () => new URLSearchParams('signal=sig-3'),
}));

const { default: AdminUserModerationPage } = await import('./page');

const PENDING = {
  id: 'action-1',
  actionType: 'ban',
  scope: 'account',
  targetUserId: 'user-7',
  providerProfileId: null,
  bookingId: null,
  refundTreatment: null,
  riskTier: 'critical',
  status: 'pending_approval',
  reason: 'Payment fraud ring.',
  userMessage: null,
  adminActionId: 'aa-1',
  reversalAdminActionId: null,
  previousUserStanding: null,
  previousProviderLifecycleStatus: null,
  originSafetyReportId: null,
  originFraudSignalId: 'sig-3',
  initiatedByAdminUserId: 'admin-1',
  createdAt: '2026-09-01T10:00:00.000Z',
  activatedAt: null,
  reversedAt: null,
};

function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift() ?? { body: { data: [] } };
    const status = next.status ?? 200;
    return { status, ok: status < 400, json: async () => next.body } as unknown as Response;
  });
}

describe('AdminUserModerationPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.cookie = 'apuriva_csrf=test';
  });

  it('renders loading and error states', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { container, unmount } = render(<AdminUserModerationPage />);
    expect(container.querySelector('main')).toBeInTheDocument();
    unmount();

    vi.stubGlobal('fetch', stubFetch([{ status: 403, body: { code: 'FORBIDDEN', message: 'No access.' } }]));
    render(<AdminUserModerationPage />);
    expect(await screen.findByText('Moderation unavailable')).toBeInTheDocument();
  });

  it('a ban needs a reason AND a confirmation; it posts with the signal origin and an Idempotency-Key', async () => {
    const fetchMock = stubFetch([
      { body: { data: [] } },
      { status: 202, body: { data: PENDING } },
      { body: { data: [PENDING] } },
      { body: { data: { ...PENDING, evidenceFileAssetIds: [], approvalChain: [], appeal: null } } },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminUserModerationPage />);

    expect(await screen.findByText('Acting on fraud signal sig-3.')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Action'), 'ban');
    const review = screen.getByRole('button', { name: 'Review and confirm' });
    expect(review).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Reason \(internal/), 'Payment fraud ring.');
    await userEvent.click(review);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm action' }));

    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/admin/moderation-actions');
    expect(JSON.parse(init.body as string)).toMatchObject({
      actionType: 'ban',
      scope: 'account',
      targetUserId: 'user-7',
      reason: 'Payment fraud ring.',
      originFraudSignalId: 'sig-3',
    });
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    expect(await screen.findByText(/awaiting a second admin/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Apply approved action' })).toBeInTheDocument();
  });

  it('a failed submit preserves the entered reason and shows the error', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([{ body: { data: [] } }, { status: 409, body: { code: 'MODERATION_ACTION_CONFLICT', message: 'A sanction of equal or greater severity is already active.' } }]),
    );
    render(<AdminUserModerationPage />);
    await userEvent.type(await screen.findByLabelText(/Reason \(internal/), 'Spam.');
    await userEvent.click(screen.getByRole('button', { name: 'Review and confirm' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm action' }));
    expect(await screen.findByText(/already active/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Reason \(internal/)).toHaveValue('Spam.');
  });

  it('shows booking fields only for a booking intervention', async () => {
    vi.stubGlobal('fetch', stubFetch([{ body: { data: [] } }]));
    render(<AdminUserModerationPage />);
    await screen.findByText('New moderation action');
    expect(screen.queryByLabelText(/Booking id/)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Action'), 'booking_intervention');
    expect(await screen.findByLabelText(/Booking id/)).toBeInTheDocument();
    expect(screen.getByLabelText('Refund')).toBeInTheDocument();
  });
});
