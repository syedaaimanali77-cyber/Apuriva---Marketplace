// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setOnline } from '@/app/_components/network-test-support';
import { en } from '@/lib/i18n/dictionaries/en';
import NewRequestPage from './page';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ serviceId: 'service-1' }),
  useRouter: () => ({ push }),
}));

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/** Spec 044 §3.5 (AC-3, X-5) — request submission is disabled offline; no request is created or queued. */
describe('NewRequestPage offline (spec 044 §3.5)', () => {
  afterEach(() => {
    setOnline(true);
    vi.unstubAllGlobals();
  });

  it('disables "Send request" with the offline notice and sends nothing', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(async (url) => {
      if (url.includes('/api/v1/locales')) return json({ data: { locales: [], resolvedLocale: 'en', platformCurrencyCode: 'PKR' } });
      if (url.includes('/fields')) return json({ data: [] });
      if (url.includes('/addresses')) return json({ data: [{ id: 'addr-1', label: 'Home', isDefault: true, structured: {}, approxAreaLabel: 'Gulberg' }] });
      return json({ data: { id: 'service-1', name: 'Plumbing' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    setOnline(true);
    render(<NewRequestPage />);
    const submit = await screen.findByRole('button', { name: en.requestNew.send });
    await waitFor(() => expect(submit).toBeEnabled());

    setOnline(false);
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription(en.errors.NETWORK_ERROR);
    await userEvent.click(submit);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();

    setOnline(true);
    expect(submit).toBeEnabled();
  });
});
