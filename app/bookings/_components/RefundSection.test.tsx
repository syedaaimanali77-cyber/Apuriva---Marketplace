// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { RefundSection } from './RefundSection';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, correlationId: 'c1' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function refund(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    bookingId: 'booking-1',
    paymentId: 'p1',
    status: 'completed',
    totalAmountMinorUnits: 50_000,
    totalCurrencyCode: 'PKR',
    lines: [{ id: 'l1', lineAmountMinorUnits: 50_000, lineCurrencyCode: 'PKR', reason: 'Cancelled within the free window' }],
    source: 'policy',
    isOverride: false,
    reconciliationState: 'pending',
    completedAt: '2026-09-20T10:00:00.000Z',
    createdAt: '2026-09-20T09:00:00.000Z',
    version: 3,
    ...over,
  };
}

function stubRefunds(rows: unknown[]): void {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(rows)));
}

/**
 * Spec 022 §5 "Customer" — the refund section's states.
 *
 * The rule that matters most: an in-flight refund is NEVER rendered as "Refunded". Master spec
 * §132.7 applies to refunds exactly as it does to payments — nothing may claim the money is back
 * before the provider confirmed it.
 */
describe('booking refund section (spec 022 §5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** §5 "Empty" — a booking with no refunds renders nothing at all, not an empty-state card. */
  it('renders nothing when the booking has no refunds', async () => {
    stubRefunds([]);
    const { container } = render(<RefundSection bookingId="booking-1" scheduledTimezone="Asia/Karachi" />);
    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  /** §5 "Processing" — the assertion this component exists for. */
  it('shows a processing refund as in progress, never as refunded', async () => {
    stubRefunds([refund({ status: 'processing', completedAt: null })]);
    render(<RefundSection bookingId="booking-1" scheduledTimezone="Asia/Karachi" />);

    expect(await screen.findByText('Refund in progress')).toBeInTheDocument();
    expect(screen.queryByText('Refunded')).not.toBeInTheDocument();
    expect(screen.getByText(/being processed by the payment provider/i)).toBeInTheDocument();
  });

  /** A `requested` refund is equally not-yet-refunded. */
  it('shows a requested refund as in progress', async () => {
    stubRefunds([refund({ status: 'requested', completedAt: null })]);
    render(<RefundSection bookingId="booking-1" scheduledTimezone="Asia/Karachi" />);

    expect(await screen.findByText('Refund in progress')).toBeInTheDocument();
    expect(screen.queryByText('Refunded')).not.toBeInTheDocument();
  });

  /** §5 "Success" — reached only when the backend says `completed`. */
  it('shows a completed refund with its amount and the decided reason', async () => {
    stubRefunds([refund()]);
    render(<RefundSection bookingId="booking-1" scheduledTimezone="Asia/Karachi" />);

    expect(await screen.findByText('Refunded')).toBeInTheDocument();
    expect(screen.getByText(/Cancelled within the free window/)).toBeInTheDocument();
    expect(screen.getByText(/500\.00/)).toBeInTheDocument();
  });

  /** §5 "Error" — honest, not a dead end, and never a raw provider code. */
  it('states plainly that a failed refund returned no money, without a provider code', async () => {
    stubRefunds([refund({ status: 'failed', completedAt: null })]);
    render(<RefundSection bookingId="booking-1" scheduledTimezone="Asia/Karachi" />);

    expect(await screen.findByText('Refund not completed')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/no money was returned by that attempt/i);
    expect(alert.textContent).toMatch(/Contact support/i);
    // The provider's machine code never reaches the customer.
    expect(alert.textContent).not.toMatch(/refund_declined/);
  });

  /** §4 — nothing provider-facing is rendered, even if a future API change leaked it. */
  it('never renders a provider reference', async () => {
    stubRefunds([refund({ refundReference: 'sandbox_refund_leak' })]);
    const { container } = render(<RefundSection bookingId="booking-1" scheduledTimezone="Asia/Karachi" />);

    await screen.findByText('Refunded');
    expect(container.textContent).not.toMatch(/sandbox_/);
  });
});
