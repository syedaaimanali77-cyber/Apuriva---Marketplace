// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PayoutMethodsPage from './page';
import type { PayoutMethodDto } from '@/lib/types/payouts';

const METHOD: PayoutMethodDto = {
  id: 'm1',
  type: 'bank',
  maskedDetail: '****1234',
  institutionLabel: 'Sandbox Bank',
  payoutCurrencyCode: 'PKR',
  verificationState: 'verified',
  isDefault: true,
  removedAt: null,
  createdAt: '2026-09-10T10:00:00.000Z',
  version: 1,
};

describe('PayoutMethodsPage (spec 024 §5.2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists masked detail only and never renders full detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [METHOD] }) })));
    render(<PayoutMethodsPage />);
    expect(await screen.findByText(/Sandbox Bank \*\*\*\*1234/)).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\d{5,}/);
  });

  it('requests a step-up token immediately before adding, and sends only the setup token', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/auth/step-up')) return { ok: true, status: 200, json: async () => ({ data: { stepUpToken: 'tok' } }) };
        if (init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ data: METHOD }) };
        return { ok: true, status: 200, json: async () => ({ data: [] }) };
      }),
    );
    render(<PayoutMethodsPage />);
    await userEvent.type(await screen.findByLabelText('Setup code'), 'sandbox_setup:bank:1234:PKR');
    await userEvent.click(screen.getByRole('button', { name: 'Add payout method' }));

    const stepUpIndex = calls.findIndex((c) => c.url.endsWith('/auth/step-up'));
    const createIndex = calls.findIndex((c) => c.url.endsWith('/payout-methods') && c.init?.method === 'POST');
    expect(stepUpIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(stepUpIndex);
    const headers = calls[createIndex]!.init!.headers as Record<string, string>;
    expect(headers['x-step-up-token']).toBe('tok');
    expect(JSON.parse(calls[createIndex]!.init!.body as string)).toEqual({ setupToken: 'sandbox_setup:bank:1234:PKR' });
  });

  it('shows the in-use reason when removal is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/auth/step-up')) return { ok: true, status: 200, json: async () => ({ data: { stepUpToken: 'tok' } }) };
        if (init?.method === 'DELETE') {
          return { ok: false, status: 422, json: async () => ({ code: 'PAYOUT_METHOD_IN_USE', message: 'This payout method is needed for a payout that is ready or in progress, so it cannot be removed yet.' }) };
        }
        return { ok: true, status: 200, json: async () => ({ data: [METHOD] }) };
      }),
    );
    render(<PayoutMethodsPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    const confirm = await screen.findAllByRole('button', { name: 'Remove' });
    await userEvent.click(confirm[confirm.length - 1]!);
    expect(await screen.findByText(/cannot be removed yet/)).toBeInTheDocument();
  });
});
