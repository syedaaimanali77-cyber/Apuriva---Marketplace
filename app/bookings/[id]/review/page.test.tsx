// @vitest-environment jsdom
/**
 * Spec 029 §6 / §5 — the customer review screen's four states.
 *
 * The state that matters most is the ineligible one: the screen must render the SERVER's reason and
 * the SERVER's deadline, never a locally-derived guess (architecture §5.4). These tests drive the
 * component with stubbed fetch responses, so they assert what the screen does with what it is told.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingReviewPage from './page';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'booking-1' }),
  useRouter: () => ({ push: vi.fn() }),
}));

// Spec 027's uploader reaches the network on mount; this screen's own behaviour is what is under
// test, so it is stubbed to a no-op rather than exercised here (spec 027 tests it directly).
vi.mock('@/app/_components/FileUpload', () => ({
  FileUpload: ({ label }: { label?: string }) => <div>{label}</div>,
}));

const ELIGIBLE = {
  bookingId: 'booking-1',
  eligible: true,
  reason: null,
  windowClosesAt: '2026-10-01T12:00:00.000Z',
  review: null,
};

function stubFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift() ?? { body: {} };
    const status = next.status ?? 200;
    return {
      status,
      // `apiFetch` branches on `res.ok`, so the stub must carry it — not just a status code.
      ok: next.ok ?? status < 400,
      json: async () => next.body,
    } as unknown as Response;
  });
}

describe('BookingReviewPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.cookie = 'csrf_token=test';
  });

  it('shows a skeleton while loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { container } = render(<BookingReviewPage />);
    expect(container.querySelector('main')).toBeInTheDocument();
  });

  it('renders the form and the SERVER deadline when eligible', async () => {
    vi.stubGlobal('fetch', stubFetch([{ body: { data: ELIGIBLE, correlationId: 'c' } }]));
    render(<BookingReviewPage />);

    expect(await screen.findByRole('group', { name: 'How was the service?' })).toBeInTheDocument();
    // The instant comes from `windowClosesAt`, not from any arithmetic in the component.
    expect(screen.getByText(/You can review this booking until/)).toBeInTheDocument();
    expect(screen.getByText(/October 1, 2026/)).toBeInTheDocument();
  });

  it('renders the server reason instead of a form when the booking is not completed', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([
        {
          body: {
            data: { ...ELIGIBLE, eligible: false, reason: 'not_completed', windowClosesAt: null },
            correlationId: 'c',
          },
        },
      ]),
    );
    render(<BookingReviewPage />);

    expect(await screen.findByText(/once this booking has been marked complete/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'How was the service?' })).not.toBeInTheDocument();
  });

  it('explains a closed window with the date the server gave', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([
        { body: { data: { ...ELIGIBLE, eligible: false, reason: 'window_closed' }, correlationId: 'c' } },
      ]),
    );
    render(<BookingReviewPage />);

    expect(await screen.findByText(/review period for this booking has closed/)).toBeInTheDocument();
    expect(screen.getByText(/The review period closed on October 1, 2026\./)).toBeInTheDocument();
  });

  it('shows an error state when the eligibility call fails', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch([{ status: 404, body: { code: 'BOOKING_NOT_FOUND', message: 'No such booking.' } }]),
    );
    render(<BookingReviewPage />);

    expect(await screen.findByText('Review unavailable')).toBeInTheDocument();
  });

  it('keeps the submit button disabled until a rating is chosen', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', stubFetch([{ body: { data: ELIGIBLE, correlationId: 'c' } }]));
    render(<BookingReviewPage />);

    const submit = await screen.findByRole('button', { name: 'Publish review' });
    expect(submit).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: '5 out of 5' }));
    expect(submit).toBeEnabled();
  });

  it('confirms publication after a successful submit', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      stubFetch([
        { body: { data: ELIGIBLE, correlationId: 'c' } },
        { status: 201, body: { data: { id: 'r1', rating: 5, status: 'published' }, correlationId: 'c' } },
      ]),
    );
    render(<BookingReviewPage />);

    await user.click(await screen.findByRole('radio', { name: '5 out of 5' }));
    await user.click(screen.getByRole('button', { name: 'Publish review' }));

    await waitFor(() => expect(screen.getByText('Thank you for your review')).toBeInTheDocument());
  });

  it('surfaces the server error message on a rejected submit', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      stubFetch([
        { body: { data: ELIGIBLE, correlationId: 'c' } },
        {
          status: 409,
          body: { code: 'REVIEW_ALREADY_EXISTS', message: 'You have already reviewed this booking.' },
        },
      ]),
    );
    render(<BookingReviewPage />);

    await user.click(await screen.findByRole('radio', { name: '4 out of 5' }));
    await user.click(screen.getByRole('button', { name: 'Publish review' }));

    await waitFor(() =>
      expect(screen.getByText('You have already reviewed this booking.')).toBeInTheDocument(),
    );
  });
});
