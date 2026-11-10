// @vitest-environment jsdom
/**
 * Spec 038 §5 — the fraud signal queue. The screen enforces nothing: "Take action" only links to the
 * account's moderation page, and triage sends the status the admin was shown.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminFraudSignalsPage from './page';

const SIGNAL = {
  id: 'sig-1',
  targetUserId: 'user-9',
  source: 'rule_based',
  ruleKey: 'repeated_safety_reports',
  observedCount: 4,
  threshold: 3,
  windowDays: 30,
  status: 'pending_review',
  createdAt: '2026-09-01T10:00:00.000Z',
  triagedByAdminUserId: null,
  triageReason: null,
  moderationActionId: null,
};

function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift() ?? { body: { data: [] } };
    const status = next.status ?? 200;
    return { status, ok: status < 400, json: async () => next.body } as unknown as Response;
  });
}

describe('AdminFraudSignalsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.cookie = 'apuriva_csrf=test';
  });

  it('shows a skeleton while loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { container } = render(<AdminFraudSignalsPage />);
    expect(container.querySelector('main')).toBeInTheDocument();
  });

  it('renders the error state when refused', async () => {
    vi.stubGlobal('fetch', stubFetch([{ status: 403, body: { code: 'FORBIDDEN', message: 'No access.' } }]));
    render(<AdminFraudSignalsPage />);
    expect(await screen.findByText('Signal queue unavailable')).toBeInTheDocument();
  });

  it('renders a calm empty state', async () => {
    vi.stubGlobal('fetch', stubFetch([{ body: { data: [] } }]));
    render(<AdminFraudSignalsPage />);
    expect(await screen.findByText('No signals pending review')).toBeInTheDocument();
  });

  it('links "Take action" to the human moderation page and dismisses with expectedStatus + reason', async () => {
    const fetchMock = stubFetch([{ body: { data: [SIGNAL] } }, { body: { data: { ...SIGNAL, status: 'dismissed' } } }, { body: { data: [] } }]);
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminFraudSignalsPage />);

    expect(await screen.findByText('Repeated safety reports')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Take action' })).toHaveAttribute('href', '/admin/users/user-9/moderation?signal=sig-1');

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Reason/), 'Coincidence.');
    await userEvent.click(save);

    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/admin/fraud-signals/sig-1/dismiss');
    expect(JSON.parse(init.body as string)).toEqual({ expectedStatus: 'pending_review', reason: 'Coincidence.' });
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
  });

  it('shows a triage failure plainly', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([{ body: { data: [SIGNAL] } }, { status: 409, body: { code: 'FRAUD_SIGNAL_STATUS_CONFLICT', message: 'Already triaged.' } }]),
    );
    render(<AdminFraudSignalsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Escalate' }));
    await userEvent.type(screen.getByLabelText(/Reason/), 'Pattern.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Already triaged.')).toBeInTheDocument();
  });
});
