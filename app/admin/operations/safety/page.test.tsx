// @vitest-environment jsdom
/**
 * Spec 030 §6 "Component" (AC-4) — the Trust & Safety queue screen.
 *
 * The assertion that matters most is the AI one: the summary must be presented as a suggestion and
 * must sit BELOW the reporter's own words. A screen that led with a machine's paraphrase is the
 * easiest way for a tired admin to stop reading what a person actually wrote.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminSafetyQueuePage from './page';

const REPORT = {
  id: 'report-1',
  status: 'submitted',
  category: 'threat',
  createdAt: '2026-09-01T10:00:00.000Z',
  evidence: [],
  reporterUserId: 'user-1',
  targetUserId: 'user-2',
  bookingId: null,
  description: 'They threatened me when I asked them to leave the property.',
  priority: 'medium',
  aiSummary: 'Reporter describes a verbal threat at the end of a job.',
  claimedByAdminId: null,
  escalatedAt: null,
  resolvedAt: null,
  resolutionReason: null,
  restrictionRequestedAt: null,
  version: 1,
};

function stubFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift() ?? { body: { data: [], correlationId: 'c' } };
    const status = next.status ?? 200;
    return {
      status,
      ok: next.ok ?? status < 400,
      json: async () => next.body,
    } as unknown as Response;
  });
}

describe('AdminSafetyQueuePage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.cookie = 'apuriva_csrf=test';
  });

  it('shows a skeleton while the queue loads', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { container } = render(<AdminSafetyQueuePage />);
    expect(container.querySelector('main')).toBeInTheDocument();
  });

  it('renders the error state when the queue is refused', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([{ status: 403, body: { code: 'FORBIDDEN', message: 'You do not have access to safety reports.' } }]),
    );
    render(<AdminSafetyQueuePage />);
    expect(await screen.findByText('Safety queue unavailable')).toBeInTheDocument();
  });

  it('renders a neutral empty state', async () => {
    vi.stubGlobal('fetch', stubFetch([{ body: { data: [], correlationId: 'c' } }]));
    render(<AdminSafetyQueuePage />);
    expect(await screen.findByText('Nothing is waiting for review.')).toBeInTheDocument();
  });

  describe('AC-4: the AI summary is a suggestion, never a verdict', () => {
    it('labels it explicitly as not a decision', async () => {
      vi.stubGlobal('fetch', stubFetch([{ body: { data: [REPORT], correlationId: 'c' } }]));
      render(<AdminSafetyQueuePage />);

      expect(await screen.findByRole('region', { name: 'AI suggestion — not a decision' })).toBeInTheDocument();
      expect(screen.getByText('AI suggestion — not a decision')).toBeInTheDocument();
    });

    it("renders the reporter's own words BEFORE the AI paraphrase", async () => {
      vi.stubGlobal('fetch', stubFetch([{ body: { data: [REPORT], correlationId: 'c' } }]));
      const { container } = render(<AdminSafetyQueuePage />);
      await screen.findByText(REPORT.description);

      const text = container.textContent ?? '';
      expect(text.indexOf(REPORT.description)).toBeLessThan(text.indexOf(REPORT.aiSummary));
    });

    it('renders nothing AI-related when there is no summary', async () => {
      vi.stubGlobal('fetch', stubFetch([{ body: { data: [{ ...REPORT, aiSummary: null }], correlationId: 'c' } }]));
      render(<AdminSafetyQueuePage />);
      await screen.findByText(REPORT.description);
      expect(screen.queryByText(/AI suggestion/)).not.toBeInTheDocument();
    });
  });

  describe('DECIDED-3: there is no sanction control on this screen', () => {
    it('offers only claim, escalate and close as decisions', async () => {
      vi.stubGlobal('fetch', stubFetch([{ body: { data: [REPORT], correlationId: 'c' } }]));
      const user = userEvent.setup();
      render(<AdminSafetyQueuePage />);

      await user.click(await screen.findByRole('button', { name: 'Action' }));
      const decision = screen.getByLabelText('Decision') as HTMLSelectElement;
      expect([...decision.options].map((o) => o.value).sort()).toEqual(['claim', 'escalate', 'resolve']);
    });

    it('never offers suspend, ban or restrict as a decision', async () => {
      vi.stubGlobal('fetch', stubFetch([{ body: { data: [REPORT], correlationId: 'c' } }]));
      const user = userEvent.setup();
      render(<AdminSafetyQueuePage />);

      await user.click(await screen.findByRole('button', { name: 'Action' }));
      const decision = screen.getByLabelText('Decision') as HTMLSelectElement;
      const values = [...decision.options].map((o) => o.value);
      expect(values).not.toContain('suspend');
      expect(values).not.toContain('ban');
      expect(values).not.toContain('restrict');
    });
  });

  it('refuses to escalate or close without a reason of the required length', async () => {
    const fetchMock = stubFetch([{ body: { data: [REPORT], correlationId: 'c' } }]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AdminSafetyQueuePage />);

    await user.click(await screen.findByRole('button', { name: 'Action' }));
    await user.selectOptions(screen.getByLabelText('Decision'), 'resolve');
    await user.type(screen.getByLabelText('Reason (recorded in the audit log)'), 'too short');
    await user.click(screen.getByRole('button', { name: 'Save decision' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A reason of 10–2000 characters is required.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the decision with the expectedStatus it was shown, then reloads', async () => {
    const fetchMock = stubFetch([
      { body: { data: [REPORT], correlationId: 'c' } },
      { body: { data: { ...REPORT, status: 'resolved' }, correlationId: 'c' } },
      { body: { data: [], correlationId: 'c' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AdminSafetyQueuePage />);

    await user.click(await screen.findByRole('button', { name: 'Action' }));
    await user.selectOptions(screen.getByLabelText('Decision'), 'resolve');
    await user.type(
      screen.getByLabelText('Reason (recorded in the audit log)'),
      'Spoke to both parties and recorded the outcome.',
    );
    await user.click(screen.getByRole('button', { name: 'Save decision' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[1]![0]).toBe('/api/v1/admin/safety-reports/report-1/resolve');
    expect(JSON.parse(calls[1]![1].body as string)).toMatchObject({
      expectedStatus: 'submitted',
      requestRestriction: false,
    });
  });

  it('AC-5: surfaces RESTRICTION_UNAVAILABLE plainly rather than implying something happened', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([
        { body: { data: [REPORT], correlationId: 'c' } },
        {
          status: 422,
          body: {
            code: 'RESTRICTION_UNAVAILABLE',
            message: 'Account restrictions are not available on this deployment.',
          },
        },
      ]),
    );
    const user = userEvent.setup();
    render(<AdminSafetyQueuePage />);

    await user.click(await screen.findByRole('button', { name: 'Action' }));
    await user.selectOptions(screen.getByLabelText('Decision'), 'resolve');
    await user.type(
      screen.getByLabelText('Reason (recorded in the audit log)'),
      'Closing this and asking for a restriction.',
    );
    await user.click(screen.getByLabelText(/ask for this account to be restricted/i));
    await user.click(screen.getByRole('button', { name: 'Save decision' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Account restrictions are not available');
  });

  it('DECIDED-1: lets an admin set a priority by hand', async () => {
    const fetchMock = stubFetch([
      { body: { data: [REPORT], correlationId: 'c' } },
      { body: { data: { ...REPORT, priority: 'critical' }, correlationId: 'c' } },
      { body: { data: [], correlationId: 'c' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AdminSafetyQueuePage />);

    await user.selectOptions(await screen.findByLabelText('Priority'), 'critical');
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[1]![0]).toBe('/api/v1/admin/safety-reports/report-1/priority');
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ priority: 'critical', expectedStatus: 'submitted' });
  });
});
