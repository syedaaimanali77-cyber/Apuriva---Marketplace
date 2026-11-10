// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminPayoutsPage from './page';
import type { AdminPayoutDto, EarningsAdjustmentDto } from '@/lib/types/payouts';

const FAILED: AdminPayoutDto = {
  id: 'p1',
  status: 'failed',
  amountMinorUnits: 288_000,
  currencyCode: 'PKR',
  itemCount: 1,
  payoutMethodMaskedDetail: '****1234',
  closedAt: '2026-09-12T10:00:00.000Z',
  paidAt: null,
  failureCode: 'transfer_rejected',
  createdAt: '2026-09-12T10:00:00.000Z',
  version: 3,
  providerProfileId: 'aaaaaaaa-0000-0000-0000-000000000000',
  attemptCount: 1,
  payoutMethodId: 'm1',
};

const ESCALATED: AdminPayoutDto = { ...FAILED, id: 'p2', status: 'processing', failureCode: null };

const PENDING_ADJUSTMENT: EarningsAdjustmentDto = {
  id: 'a1',
  kind: 'credit',
  adjustmentAmountMinorUnits: 5_000,
  currencyCode: 'PKR',
  reason: 'Goodwill',
  adminActionId: 'act1',
  providerProfileId: FAILED.providerProfileId,
  appliedAt: null,
  payoutId: null,
  createdAt: '2026-09-12T10:00:00.000Z',
};

describe('AdminPayoutsPage (spec 024 §5.3)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows approval-gated retry and adjustment controls, and offers no mark-paid or mark-failed control', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => ({ data: url.includes('earnings-adjustments') ? [PENDING_ADJUSTMENT] : [FAILED, ESCALATED] }),
      })),
    );
    render(<AdminPayoutsPage />);
    expect(await screen.findByRole('button', { name: 'Retry…' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Retry…' })).toHaveLength(1); // only the failed payout
    expect(screen.getByText('Awaiting approval / execution')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Pending approvals' })).toHaveAttribute('href', '/admin/approvals');
    expect(screen.queryByRole('button', { name: /mark (as )?(paid|failed)/i })).not.toBeInTheDocument();
    expect(document.body.textContent).toContain('****1234');
    expect(document.body.textContent).not.toContain('sandbox_payout_');
  });

  it('disables adjustment submission until provider, amount and reason are present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })));
    render(<AdminPayoutsPage />);
    expect(await screen.findByRole('button', { name: 'Submit for approval' })).toBeDisabled();
  });
});
