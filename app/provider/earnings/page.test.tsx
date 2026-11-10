// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProviderEarningsPage from './page';
import type { EarningsLineDto, EarningsSummaryDto, PayoutDetailDto, PayoutDto } from '@/lib/types/payouts';

const SUMMARY: EarningsSummaryDto = {
  currencyCode: 'PKR',
  grossAmountMinorUnits: 320_000,
  feeAmountMinorUnits: 32_000,
  refundsAmountMinorUnits: 0,
  adjustmentsAmountMinorUnits: 0,
  netAmountMinorUnits: 288_000,
  pendingAmountMinorUnits: 0,
  upcomingAmountMinorUnits: 0,
  paidAmountMinorUnits: 288_000,
  balanceAmountMinorUnits: 0,
  payoutMethodRequired: false,
  payoutOnHold: false,
  availableCurrencyCodes: ['PKR'],
};

const LINE: EarningsLineDto = {
  id: 'l1',
  bookingId: 'b1',
  serviceId: 's1',
  state: 'paid',
  currencyCode: 'PKR',
  grossAmountMinorUnits: 320_000,
  platformFeeBps: 1000,
  feeAmountMinorUnits: 32_000,
  refundedAmountMinorUnits: 0,
  feeReversalAmountMinorUnits: 0,
  netAmountMinorUnits: 288_000,
  scheduledAt: '2026-09-10T10:00:00.000Z',
  eligibleAt: '2026-09-12T10:00:00.000Z',
  paidAt: '2026-09-13T10:00:00.000Z',
  payoutId: 'p1',
  createdAt: '2026-09-12T10:00:00.000Z',
  version: 1,
};

const PAYOUT = (overrides: Partial<PayoutDto>): PayoutDto => ({
  id: 'p1',
  status: 'paid',
  amountMinorUnits: 288_000,
  currencyCode: 'PKR',
  itemCount: 1,
  payoutMethodMaskedDetail: '****1234',
  closedAt: null,
  paidAt: '2026-09-13T10:00:00.000Z',
  failureCode: null,
  createdAt: '2026-09-12T10:00:00.000Z',
  version: 1,
  ...overrides,
});

function mockApi(summary: EarningsSummaryDto, lines: EarningsLineDto[], payouts: PayoutDto[], detail?: PayoutDetailDto) {
  const fn = vi.fn(async (url: string) => {
    const respond = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) });
    if (url.includes('/earnings/lines')) return respond(lines);
    if (url.includes('/earnings')) return respond(summary);
    if (/\/payouts\/[^?]/.test(url)) return respond(detail);
    return respond(payouts);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const money = (minor: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'PKR' }).format(minor / 100).replace(/\s/g, ' ');
const pageText = () => (document.body.textContent ?? '').replace(/\s/g, ' ');

describe('ProviderEarningsPage (spec 024 §5.1)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('renders all eight figures exactly as served, with no client arithmetic', async () => {
    // Deliberately inconsistent figures: the page must render what it was given, not recompute.
    mockApi({ ...SUMMARY, netAmountMinorUnits: 111, paidAmountMinorUnits: 222 }, [LINE], [PAYOUT({})]);
    render(<ProviderEarningsPage />);
    await screen.findByTestId('figure-netAmountMinorUnits');
    expect(screen.getByTestId('figure-netAmountMinorUnits').textContent!.replace(/\s/g, ' ')).toBe(money(111));
    expect(screen.getByTestId('figure-paidAmountMinorUnits').textContent!.replace(/\s/g, ' ')).toBe(money(222));
    for (const key of ['gross', 'fee', 'refunds', 'adjustments', 'net', 'pending', 'upcoming', 'paid']) {
      expect(screen.getByTestId(`figure-${key}AmountMinorUnits`)).toBeInTheDocument();
    }
  });

  it('links each earnings row to the provider booking detail screen', async () => {
    mockApi(SUMMARY, [LINE], [PAYOUT({})]);
    render(<ProviderEarningsPage />);
    expect(await screen.findByRole('link', { name: 'View booking' })).toHaveAttribute('href', '/provider/schedule/bookings/b1');
  });

  it('never renders a processing payout as paid', async () => {
    mockApi(SUMMARY, [LINE], [PAYOUT({ status: 'processing', paidAt: null })]);
    render(<ProviderEarningsPage />);
    expect(await screen.findByText('Payout in progress')).toBeInTheDocument();
    expect(screen.queryByText(/^Paid /)).not.toBeInTheDocument();
  });

  it('keeps a failed payout visible with its next step', async () => {
    mockApi(SUMMARY, [LINE], [PAYOUT({ status: 'failed', paidAt: null, failureCode: 'destination_invalid' })]);
    render(<ProviderEarningsPage />);
    expect(await screen.findByText(/did not complete, and the money is back in your payable balance/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /payout method/i }).length).toBeGreaterThan(0);
  });

  it('shows the no-payout-method alert exactly when payoutMethodRequired, and the hold without a reason', async () => {
    mockApi({ ...SUMMARY, payoutMethodRequired: true, payoutOnHold: true }, [LINE], []);
    render(<ProviderEarningsPage />);
    expect(await screen.findByText('Add a payout method to be paid')).toBeInTheDocument();
    expect(screen.getByText('Payout on hold')).toBeInTheDocument();
    expect(screen.queryByText(/fraud|suspicious/i)).not.toBeInTheDocument();
  });

  it('shows a negative balance with its recovery items rather than hiding it', async () => {
    const open = PAYOUT({ id: 'p2', status: 'pending', amountMinorUnits: -5_000, paidAt: null });
    mockApi({ ...SUMMARY, balanceAmountMinorUnits: -5_000, upcomingAmountMinorUnits: -5_000 }, [LINE], [open], {
      ...open,
      items: [{ id: 'i1', kind: 'refund_recovery', earningsLineId: 'l1', adjustmentId: null, bookingId: 'b1', itemAmountMinorUnits: -5_000, currencyCode: 'PKR' }],
    });
    render(<ProviderEarningsPage />);
    expect(await screen.findByText('Amount to be recovered')).toBeInTheDocument();
    expect(pageText()).toContain(money(-5_000));
  });

  it('shows the currency switcher only when there is more than one currency, and an empty state for a new provider', async () => {
    mockApi({ ...SUMMARY, availableCurrencyCodes: [] }, [], []);
    const { unmount } = render(<ProviderEarningsPage />);
    expect(await screen.findByText('No earnings yet')).toBeInTheDocument();
    expect(screen.queryByLabelText('Currency')).not.toBeInTheDocument();
    unmount();

    mockApi({ ...SUMMARY, availableCurrencyCodes: ['PKR', 'USD'] }, [LINE], []);
    render(<ProviderEarningsPage />);
    expect(await screen.findByLabelText('Currency')).toBeInTheDocument();
  });

  it('shows the ErrorState with a retry when loading fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ code: 'INTERNAL_ERROR', message: 'boom' }) })));
    render(<ProviderEarningsPage />);
    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
