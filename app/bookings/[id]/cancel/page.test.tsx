// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { CancellationConsequenceDto } from '@/lib/types/cancellation';
import CancelBookingPage from './page';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'booking-1' }),
  useRouter: () => ({ refresh: vi.fn() }),
}));

const apiFetch = vi.fn();
vi.mock('../../booking-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  mutateHeaders: (extra?: Record<string, string>) => ({ 'content-type': 'application/json', ...extra }),
}));

const PREVIEW: CancellationConsequenceDto = {
  cancellable: true,
  tier: { minHoursBefore: 12, maxHoursBefore: 24, feePercent: 25 },
  hoursBefore: 18,
  capturedAmountMinorUnits: 320_000,
  feeAmountMinorUnits: 80_000,
  refundAmountMinorUnits: 240_000,
  currencyCode: 'PKR',
  policyVersionId: 'version-1',
  policySource: 'platform_default',
  providerOptionKey: null,
};

/**
 * Spec 023 §5 — master spec §38's "show consequence before confirmation", as UI behaviour.
 *
 * The screen must state the exact fee and the exact refund BEFORE the customer commits, and the
 * confirmation dialog must repeat both. A cancellation screen that hid either number, or that let a
 * customer confirm before seeing them, would break the promise however correct the server was.
 */
describe('cancel booking screen (spec 023 AC-3)', () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the exact fee and refund, and which tier applies, before anything is confirmed', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: PREVIEW });
    render(<CancelBookingPage />);

    expect(await screen.findByText('12–24 hours before')).toBeInTheDocument();
    expect(screen.getByText(/PKR\s?800\.00|₨\s?800\.00|PKR800\.00/)).toBeInTheDocument();
    expect(screen.getByText(/PKR\s?2,400\.00|₨\s?2,400\.00|PKR2,400\.00/)).toBeInTheDocument();
  });

  it('requires an explicit confirmation that names both amounts', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: PREVIEW });
    render(<CancelBookingPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Cancel booking' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/A fee of/);
    expect(dialog).toHaveTextContent(/will be refunded/);
    expect(dialog).toHaveTextContent(/cannot be undone/);
  });

  /** The request body must carry no amount: the server recomputes under the booking row lock. */
  it('sends no amount, tier or timestamp when confirming', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: PREVIEW });
    apiFetch.mockResolvedValueOnce({
      ok: true,
      data: {
        id: 'cancellation-1',
        bookingId: 'booking-1',
        cancelledByRole: 'customer',
        reasonCode: null,
        policyVersionId: 'version-1',
        tier: PREVIEW.tier,
        capturedAmountMinorUnits: 320_000,
        feeAmountMinorUnits: 80_000,
        refundAmountMinorUnits: 240_000,
        currencyCode: 'PKR',
        bookingStatus: 'cancelled',
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
    });

    render(<CancelBookingPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel booking' }));
    await userEvent.click(await screen.findByRole('button', { name: /yes, cancel/i }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const [, init] = apiFetch.mock.calls[1]!;
    const body = JSON.parse((init as RequestInit).body as string);

    expect(body).toEqual({});
    expect((init as RequestInit).headers).toHaveProperty('Idempotency-Key');
  });

  it('reports the outcome with both amounts once cancelled', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: PREVIEW });
    apiFetch.mockResolvedValueOnce({
      ok: true,
      data: {
        id: 'cancellation-1',
        bookingId: 'booking-1',
        cancelledByRole: 'customer',
        reasonCode: null,
        policyVersionId: 'version-1',
        tier: PREVIEW.tier,
        capturedAmountMinorUnits: 320_000,
        feeAmountMinorUnits: 80_000,
        refundAmountMinorUnits: 240_000,
        currencyCode: 'PKR',
        bookingStatus: 'cancelled',
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
    });

    render(<CancelBookingPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel booking' }));
    await userEvent.click(await screen.findByRole('button', { name: /yes, cancel/i }));

    expect(await screen.findByText('Booking cancelled')).toBeInTheDocument();
    // Never "refunded": spec 022 only says that once the provider confirms it (master spec §132.7).
    expect(screen.getByText(/refund is being processed/i)).toBeInTheDocument();
  });

  it('explains a booking that cannot be cancelled instead of offering the action', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: true,
      data: { cancellable: false, blockedReason: 'BOOKING_NOT_CANCELLABLE' },
    });
    render(<CancelBookingPage />);

    expect(await screen.findByText('This booking cannot be cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel booking' })).not.toBeInTheDocument();
  });

  it('says plainly when it has already been cancelled', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: true,
      data: { cancellable: false, blockedReason: 'BOOKING_ALREADY_CANCELLED' },
    });
    render(<CancelBookingPage />);

    expect(await screen.findByText(/already been cancelled/i)).toBeInTheDocument();
  });

  it('surfaces a server error without leaving a dead end', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: PREVIEW });
    apiFetch.mockResolvedValueOnce({
      ok: false,
      error: { code: 'BOOKING_NOT_CANCELLABLE', message: 'A booking in "in_progress" cannot be cancelled.' },
    });

    render(<CancelBookingPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel booking' }));
    await userEvent.click(await screen.findByRole('button', { name: /yes, cancel/i }));

    expect(await screen.findByText(/cannot be cancelled\./i)).toBeInTheDocument();
  });
});
