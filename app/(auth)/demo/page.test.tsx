// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/dictionaries/en';
import { DemoEntry } from './DemoEntry';

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const guards = vi.hoisted(() => ({ isDemoAvailable: vi.fn() }));
vi.mock('@/lib/demo/guards', () => ({ isDemoAvailable: guards.isDemoAvailable }));

function json(ok: boolean, body: unknown) {
  return { ok, json: async () => body };
}

/** Spec 045 §5 — the /demo entry page's loading, unavailable, error and success states. */
describe('/demo entry page', () => {
  beforeEach(() => {
    router.push.mockReset();
    router.refresh.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('the server component decides availability server-side', async () => {
    const { default: DemoPage } = await import('./page');
    guards.isDemoAvailable.mockResolvedValue(false);
    render(await DemoPage());
    expect(screen.getByText(en.demo.entry.unavailableTitle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.demo.entry.tryCustomer })).not.toBeInTheDocument();
  });

  it('offers exactly the two personas — no admin — and an admin note', () => {
    render(<DemoEntry available />);
    expect(screen.getByRole('button', { name: en.demo.entry.tryCustomer })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.demo.entry.tryProvider })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /admin/i })).not.toBeInTheDocument();
    expect(screen.getByText(en.demo.entry.adminNote)).toBeInTheDocument();
  });

  it('customer: one click calls D1 with the persona, shows the loading state, then lands on /', async () => {
    let resolve!: (value: unknown) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((r) => (resolve = r)));
    vi.stubGlobal('fetch', fetchMock);
    render(<DemoEntry available />);
    await userEvent.setup().click(screen.getByRole('button', { name: en.demo.entry.tryCustomer }));

    expect(await screen.findByText(en.demo.entry.loading)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.demo.entry.tryProvider })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/demo/login', expect.objectContaining({ method: 'POST', body: JSON.stringify({ persona: 'customer' }) }));

    resolve(json(true, { data: { userId: 'u', sessionId: 's', mfaRequired: false, roles: [] } }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/'));
  });

  it('provider: switches the new session to provider mode, then lands on the provider dashboard', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(true, { data: { userId: 'u', sessionId: 's', mfaRequired: false, roles: [] } }))
      .mockResolvedValueOnce(json(true, { data: { activeMode: 'provider' } }));
    vi.stubGlobal('fetch', fetchMock);
    render(<DemoEntry available />);
    await userEvent.setup().click(screen.getByRole('button', { name: en.demo.entry.tryProvider }));

    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/provider/dashboard'));
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/users/me/active-mode');
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ mode: 'provider' }) });
  });

  it('a refusal for an unavailable environment renders the unavailable state, not a retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(false, { code: 'DEMO_MODE_DISABLED', message: 'Demo mode is not enabled in this environment.' })));
    render(<DemoEntry available />);
    await userEvent.setup().click(screen.getByRole('button', { name: en.demo.entry.tryCustomer }));
    expect(await screen.findByText(en.demo.entry.unavailableTitle)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('any other failure shows the error state with a retry that tries the same persona again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(false, { code: 'INTERNAL_ERROR', message: 'boom' }))
      .mockResolvedValueOnce(json(true, { data: { userId: 'u', sessionId: 's', mfaRequired: false, roles: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<DemoEntry available />);
    await user.click(screen.getByRole('button', { name: en.demo.entry.tryCustomer }));
    expect(await screen.findByText(en.demo.entry.error)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
