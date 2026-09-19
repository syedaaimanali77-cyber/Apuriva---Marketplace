// @vitest-environment jsdom
/**
 * Spec 029 §6 "Component" — the review moderation queue screen.
 *
 * What these tests are really protecting is AC-4 and AC-8, at the one screen where a human can
 * actually hide something. So they assert three things beyond the ordinary state coverage:
 *
 *  - the queue presents a flag as an observation ("What a rule noticed") and shows the reviewed
 *    text in full, rather than leading with a verdict a tired admin would rubber-stamp;
 *  - no reporter identity is rendered, because `AdminReviewDto.reports` deliberately carries only
 *    reason, details and timestamp (§4 "Retention and privacy");
 *  - a removal cannot leave without a reason, and the request carries `expectedStatus` — the
 *    optimistic-concurrency token that stops two admins silently overwriting each other (§3 R7).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminReviewModerationPage from './page';

const FLAGGED_REVIEW = {
  id: 'review-1',
  bookingId: 'booking-1',
  providerProfileId: 'provider-1',
  serviceId: 'service-1',
  rating: 1,
  text: 'They never turned up and would not answer the phone all afternoon.',
  media: [],
  response: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  status: 'flagged',
  version: 1,
  flagSignals: ['contact_sharing'],
  reportCount: 1,
  reports: [
    { id: 'report-1', reason: 'false_information', details: null, createdAt: '2026-09-02T10:00:00.000Z' },
  ],
  moderatedAt: null,
  removalReason: null,
};

function stubFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift() ?? { body: { data: [], correlationId: 'c' } };
    const status = next.status ?? 200;
    return {
      status,
      // `apiFetch` branches on `res.ok`, so the stub must carry it — not just a status code.
      ok: next.ok ?? status < 400,
      json: async () => next.body,
    } as unknown as Response;
  });
}

describe('AdminReviewModerationPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.cookie = 'apuriva_csrf=test';
  });

  it('shows a skeleton while the queue loads', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { container } = render(<AdminReviewModerationPage />);
    expect(container.querySelector('main')).toBeInTheDocument();
  });

  it('renders the error state when the queue cannot be loaded', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([{ status: 403, body: { code: 'FORBIDDEN', message: 'You do not have access to this queue.' } }]),
    );
    render(<AdminReviewModerationPage />);

    expect(await screen.findByText('Moderation queue unavailable')).toBeInTheDocument();
    expect(screen.getByText('You do not have access to this queue.')).toBeInTheDocument();
  });

  it('renders a neutral empty state when nothing is waiting', async () => {
    vi.stubGlobal('fetch', stubFetch([{ body: { data: [], correlationId: 'c' } }]));
    render(<AdminReviewModerationPage />);

    expect(await screen.findByText('Nothing is waiting for review.')).toBeInTheDocument();
  });

  it('presents the flag as an observation, shows the review in full, and names no reporter', async () => {
    vi.stubGlobal('fetch', stubFetch([{ body: { data: [FLAGGED_REVIEW], correlationId: 'c' } }]));
    render(<AdminReviewModerationPage />);

    // The review's own words are shown verbatim — a 1-star account of a bad job is exactly the
    // legitimate criticism master §52 forbids suppressing, so the admin reads it, not a summary.
    expect(await screen.findByText(FLAGGED_REVIEW.text)).toBeInTheDocument();

    // A signal is labelled as something a RULE noticed, never as a conclusion about the reviewer.
    expect(screen.getByRole('region', { name: 'What a rule noticed' })).toBeInTheDocument();
    expect(
      screen.getByText('Contains something that looks like a phone number or email address'),
    ).toBeInTheDocument();

    // The report is shown as what someone said; the payload carries no reporter identity and the
    // screen therefore renders none.
    expect(screen.getByText('Reports (1)')).toBeInTheDocument();
    expect(screen.getByText('Untrue account of what happened')).toBeInTheDocument();
    expect(screen.queryByText(/report(ed|er)? by/i)).not.toBeInTheDocument();
  });

  it('refuses to submit a decision without a reason of the required length', async () => {
    const fetchMock = stubFetch([{ body: { data: [FLAGGED_REVIEW], correlationId: 'c' } }]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AdminReviewModerationPage />);

    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    await user.type(screen.getByLabelText('Reason (recorded in the audit log)'), 'too short');
    await user.click(screen.getByRole('button', { name: 'Save decision' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A reason of 10–2000 characters is required.');
    // Only the initial queue load happened: no resolve request was ever sent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the decision, the reason and the expectedStatus it was shown, then reloads the queue', async () => {
    const fetchMock = stubFetch([
      { body: { data: [FLAGGED_REVIEW], correlationId: 'c' } },
      { body: { data: { ...FLAGGED_REVIEW, status: 'removed' }, correlationId: 'c' } },
      { body: { data: [], correlationId: 'c' } },
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<AdminReviewModerationPage />);

    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    await user.selectOptions(screen.getByLabelText('Decision'), 'remove');
    await user.type(
      screen.getByLabelText('Reason (recorded in the audit log)'),
      'Contains a phone number the reviewer asked us to remove.',
    );
    await user.click(screen.getByRole('button', { name: 'Save decision' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // `stubFetch` declares no parameters, so vitest infers a zero-length argument tuple for
    // `mock.calls`; the recorded arguments are read through this alias instead of indexing it.
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;

    const [url, init] = calls[1]!;
    expect(url).toBe('/api/v1/admin/reviews/review-1/resolve');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      decision: 'remove',
      reason: 'Contains a phone number the reviewer asked us to remove.',
      // The status the admin was actually looking at — not a status the client invented.
      expectedStatus: 'flagged',
    });

    // The queue is re-read from the server afterwards rather than patched locally, so a second
    // admin's concurrent decision is picked up immediately.
    expect(calls[2]?.[0]).toBe('/api/v1/admin/reviews/moderation-queue');
    expect(await screen.findByText('Nothing is waiting for review.')).toBeInTheDocument();
  });

  it('surfaces a stale-status conflict from the server instead of retrying blindly', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([
        { body: { data: [FLAGGED_REVIEW], correlationId: 'c' } },
        {
          status: 409,
          body: { code: 'CONFLICT', message: 'Another admin already resolved this review.' },
        },
      ]),
    );
    const user = userEvent.setup();
    render(<AdminReviewModerationPage />);

    await user.click(await screen.findByRole('button', { name: 'Resolve' }));
    await user.type(
      screen.getByLabelText('Reason (recorded in the audit log)'),
      'Duplicate of the report resolved earlier today.',
    );
    await user.click(screen.getByRole('button', { name: 'Save decision' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Another admin already resolved this review.');
  });
});
