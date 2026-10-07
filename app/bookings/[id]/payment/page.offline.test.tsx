// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { setOnline } from '@/app/_components/network-test-support';
import { en } from '@/lib/i18n/dictionaries/en';
import BookingPaymentPage from './page';

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'booking-1' }) }));

const booking = { id: 'booking-1', status: 'pending', priceAmountMinorUnits: 320_000, currencyCode: 'PKR', scheduledAt: '2026-09-20T10:00:00.000Z', scheduledTimezone: 'Asia/Karachi' };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubFetch(authorize: () => Response) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') return authorize();
    if (url.endsWith('/payment')) return reply({ status: 404, code: 'PAYMENT_NOT_FOUND', message: 'No payment' }, 404);
    if (url.endsWith('/price-adjustments')) return reply({ data: [] });
    return reply({ data: booking });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const posts = (fn: ReturnType<typeof stubFetch>) => fn.mock.calls.filter(([, init]) => init?.method === 'POST');

/** Spec 044 §3.5 (AC-2, AC-3, X-5) — payment is disabled offline; nothing is charged or shown as paid. */
describe('booking payment page offline (spec 044 §3.5)', () => {
  afterEach(() => {
    setOnline(true);
    vi.unstubAllGlobals();
  });

  it('disables "Pay now" with the offline notice, sends nothing, and re-enables on reconnect', async () => {
    const fn = stubFetch(() => reply({ data: {} }));
    setOnline(true);
    render(<BookingPaymentPage />);
    const pay = await screen.findByRole('button', { name: en.payment.payNow });

    setOnline(false);
    expect(pay).toBeDisabled();
    expect(pay).toHaveAccessibleDescription(en.errors.NETWORK_ERROR);
    await userEvent.click(pay);
    expect(posts(fn)).toHaveLength(0);
    expect(screen.queryByText(en.payment.confirmed)).not.toBeInTheDocument();

    setOnline(true);
    expect(pay).toBeEnabled();
  });

  it('after a failed payment, offline withholds "Try again" and disables "Change payment method"', async () => {
    const fn = stubFetch(() => reply({ status: 422, code: 'PAYMENT_FAILED', message: 'x' }, 422));
    setOnline(true);
    render(<BookingPaymentPage />);
    await userEvent.click(await screen.findByRole('button', { name: en.payment.payNow }));
    const change = await screen.findByRole('button', { name: en.payment.changeMethod });
    expect(screen.getByRole('button', { name: en.payment.tryAgain })).toBeInTheDocument();
    const before = posts(fn).length;

    setOnline(false);
    expect(screen.queryByRole('button', { name: en.payment.tryAgain })).not.toBeInTheDocument();
    expect(change).toBeDisabled();
    expect(change).toHaveAccessibleDescription(en.errors.NETWORK_ERROR);
    await userEvent.click(change);
    expect(posts(fn)).toHaveLength(before);
  });
});
