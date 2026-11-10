// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import BookingPaymentPage from './page';

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'booking-1' }) }));

const booking = {
  id: 'booking-1',
  status: 'pending',
  priceAmountMinorUnits: 320_000,
  currencyCode: 'PKR',
  scheduledAt: '2026-09-20T10:00:00.000Z',
  scheduledTimezone: 'Asia/Karachi',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, correlationId: 'c1' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ status, code, message, correlationId: 'c1' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Spec 021 §5 — the payment screen's three states.
 *
 * The rule under test is the one that matters most on this screen: NEVER show an optimistic
 * success. Master spec §132.7 and §103 both require that nothing says "paid" before the backend
 * has a provider-confirmed capture, and §105 fixes the exact failure copy.
 */
describe('booking payment page (spec 021 §5)', () => {
  beforeEach(() => {
    document.cookie = 'apuriva_csrf=token';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Error state — master spec §105's exact payment wording, plus both recovery affordances. */
  it('renders the §105 payment error wording and offers retry and change payment method', async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') {
          return errorResponse('PAYMENT_FAILED', "Payment wasn't completed. No charge was confirmed.", 422);
        }
        if (url.endsWith('/payment')) return errorResponse('PAYMENT_NOT_FOUND', 'No payment', 404);
        if (url.endsWith('/price-adjustments')) return jsonResponse([]);
        return jsonResponse(booking);
      }),
    );

    render(<BookingPaymentPage />);

    const payButton = await screen.findByRole('button', { name: /pay now/i });
    await user.click(payButton);

    expect(await screen.findByText("Payment wasn't completed.")).toBeInTheDocument();
    expect(screen.getByText('No charge was confirmed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change payment method/i })).toBeInTheDocument();

    // Nothing anywhere claims the booking is paid or confirmed.
    expect(screen.queryByText(/payment confirmed/i)).not.toBeInTheDocument();
  });

  /** Success state — reached only after the server returned a captured payment. */
  it('shows payment confirmed only after the server returns a captured payment', async () => {
    const user = userEvent.setup();
    let paid = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'POST') {
          paid = true;
          return jsonResponse({ id: 'p1', bookingId: 'booking-1', status: 'captured', protectionState: null });
        }
        if (url.endsWith('/payment')) {
          return paid
            ? jsonResponse({ id: 'p1', bookingId: 'booking-1', status: 'captured', protectionState: null })
            : errorResponse('PAYMENT_NOT_FOUND', 'No payment', 404);
        }
        if (url.endsWith('/price-adjustments')) return jsonResponse([]);
        return jsonResponse(booking);
      }),
    );

    render(<BookingPaymentPage />);

    const payButton = await screen.findByRole('button', { name: /pay now/i });
    // Before the click there is no success message anywhere on the page.
    expect(screen.queryByText(/payment confirmed/i)).not.toBeInTheDocument();

    await user.click(payButton);

    await waitFor(() => expect(screen.getByText(/payment confirmed by the payment provider/i)).toBeInTheDocument());
  });

  /**
   * Master spec §90's financial-tier confirmation, bound to exact parameters: the dialog states the
   * exact additional amount and currency before the customer can approve (§132.15).
   */
  it('shows the exact amount and currency before approving a price change', async () => {
    const user = userEvent.setup();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/payment')) {
          return jsonResponse({ id: 'p1', bookingId: 'booking-1', status: 'captured', protectionState: null });
        }
        if (url.endsWith('/price-adjustments')) {
          return jsonResponse([
            {
              id: 'adj-1',
              bookingId: 'booking-1',
              additionalAmountMinorUnits: 45_000,
              additionalCurrencyCode: 'PKR',
              reason: 'Replacement part required',
              status: 'pending_approval',
              approvedAt: null,
            },
          ]);
        }
        return jsonResponse(booking);
      }),
    );

    render(<BookingPaymentPage />);

    expect(await screen.findByText('Replacement part required')).toBeInTheDocument();
    expect(screen.getByText(/nothing extra is charged unless you approve it/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /review and approve/i }));

    const dialogText = await screen.findByText(/you will be charged an additional/i);
    expect(dialogText.textContent).toMatch(/450\.00/);
    expect(dialogText.textContent).toMatch(/Replacement part required/);
    expect(dialogText.textContent).toMatch(/Nothing is charged until you approve/);
  });

  /** Protection state is reported flatly from backend state, with no dispute UI (spec 031's). */
  it('reports an active protection window without offering any dispute action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/payment')) {
          return jsonResponse({
            id: 'p1',
            bookingId: 'booking-1',
            status: 'captured',
            protectionState: 'held',
            protectionWindowEndsAt: '2026-09-22T10:00:00.000Z',
          });
        }
        if (url.endsWith('/price-adjustments')) return jsonResponse([]);
        return jsonResponse(booking);
      }),
    );

    render(<BookingPaymentPage />);

    expect(await screen.findByText(/payment protection is active/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dispute/i })).not.toBeInTheDocument();
  });
});
