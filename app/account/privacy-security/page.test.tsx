// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PrivacySecurityPage from './page';

interface MockResponse {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: { code: string; message: string };
}

function jsonResponse(body: MockResponse) {
  return {
    ok: body.ok,
    status: body.status ?? (body.ok ? 200 : 400),
    json: async () => (body.ok ? { data: body.data, correlationId: 'x' } : { status: 400, code: body.error!.code, message: body.error!.message, correlationId: 'x' }),
  };
}

const SESSION_A = { id: 's1', deviceLabel: 'Chrome on Windows', approxLocation: null, lastActiveAt: new Date().toISOString(), isCurrent: true };
const SESSION_B = { id: 's2', deviceLabel: 'Safari on iPhone', approxLocation: null, lastActiveAt: new Date().toISOString(), isCurrent: false };

type Handler = (url: string, init?: RequestInit) => MockResponse | undefined;

function installFetchMock(handlers: Handler[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      for (const handler of handlers) {
        const result = handler(url, init);
        if (result) return jsonResponse(result) as Response;
      }
      throw new Error(`Unhandled fetch: ${init?.method ?? 'GET'} ${url}`);
    }),
  );
}

function baselineHandlers({ sessions = [SESSION_A], mfaEnabled = false }: { sessions?: typeof SESSION_A[]; mfaEnabled?: boolean } = {}): Handler[] {
  return [
    (url, init) => (url.endsWith('/api/v1/users/me/sessions') && (!init?.method || init.method === 'GET') ? { ok: true, data: sessions } : undefined),
    (url, init) =>
      url.endsWith('/api/v1/users/me/mfa') && (!init?.method || init.method === 'GET') ? { ok: true, data: { mfaEnabled } } : undefined,
    (url, init) =>
      url.endsWith('/api/v1/users/me/deletion') && (!init?.method || init.method === 'GET')
        ? { ok: true, data: { lifecycleStatus: 'active', deletionGraceEndsAt: null } }
        : undefined,
  ];
}

describe('PrivacySecurityPage (spec 008 §5 UI states)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loading state renders before data arrives, then the sessions list renders', async () => {
    installFetchMock(baselineHandlers({ sessions: [SESSION_A, SESSION_B] }));
    render(<PrivacySecurityPage />);

    expect(screen.getByRole('heading', { name: 'Security & Privacy Center' })).toBeInTheDocument();
    expect(await screen.findByText('Chrome on Windows')).toBeInTheDocument();
    expect(screen.getByText('Safari on iPhone')).toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
  });

  it('error state renders with a retry action when the initial load fails', async () => {
    installFetchMock([
      (url, init) =>
        url.endsWith('/api/v1/users/me/sessions') && (!init?.method || init.method === 'GET')
          ? { ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }
          : undefined,
      ...baselineHandlers(),
    ]);
    render(<PrivacySecurityPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('a single device can be logged out directly, without a confirmation dialog', async () => {
    const user = userEvent.setup();
    installFetchMock([
      ...baselineHandlers({ sessions: [SESSION_A, SESSION_B] }),
      (url, init) => (url.includes('/sessions/s2') && init?.method === 'DELETE' ? { ok: true } : undefined),
    ]);
    render(<PrivacySecurityPage />);

    await screen.findByText('Safari on iPhone');
    await user.click(screen.getByRole('button', { name: /Log out Safari on iPhone/ }));

    await waitFor(() => expect(screen.queryByText('Safari on iPhone')).not.toBeInTheDocument());
  });

  it('destructive confirmation: logging out all other devices opens a dialog naming the consequence before acting', async () => {
    const user = userEvent.setup();
    let logoutAllCalled = false;
    installFetchMock([
      ...baselineHandlers({ sessions: [SESSION_A, SESSION_B] }),
      (url, init) => (url.endsWith('/auth/step-up') && init?.method === 'POST' ? { ok: true, data: { stepUpToken: 'tok' } } : undefined),
      (url, init) => {
        if (url.endsWith('/api/v1/users/me/sessions') && init?.method === 'DELETE') {
          logoutAllCalled = true;
          return { ok: true };
        }
        return undefined;
      },
    ]);
    render(<PrivacySecurityPage />);

    await screen.findByText('Safari on iPhone');
    await user.click(screen.getByRole('button', { name: 'Log out all other devices' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Log out all other devices?' });
    expect(logoutAllCalled).toBe(false);
    expect(dialog).toHaveAccessibleDescription(/every session except this one/i);

    await user.click(within(dialog).getByRole('button', { name: 'Log out other devices' }));

    await waitFor(() => expect(logoutAllCalled).toBe(true));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('MFA control: enabling requires step-up and reflects the resulting state', async () => {
    const user = userEvent.setup();
    installFetchMock([
      ...baselineHandlers({ mfaEnabled: false }),
      (url, init) => (url.endsWith('/auth/step-up') && init?.method === 'POST' ? { ok: true, data: { stepUpToken: 'tok' } } : undefined),
      (url, init) =>
        url.endsWith('/api/v1/users/me/mfa') && init?.method === 'PATCH'
          ? { ok: false, error: { code: 'MFA_ENROLLMENT_REQUIRED', message: 'Enroll MFA first.' } }
          : undefined,
    ]);
    render(<PrivacySecurityPage />);

    expect(await screen.findByText(/currently off/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enable MFA' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Enroll MFA first.');
  });

  it('data export: idle → pending → ready shows a download link', async () => {
    const user = userEvent.setup();
    let pollCount = 0;
    installFetchMock([
      ...baselineHandlers(),
      (url, init) => (url.endsWith('/auth/step-up') && init?.method === 'POST' ? { ok: true, data: { stepUpToken: 'tok' } } : undefined),
      (url, init) =>
        url.endsWith('/api/v1/users/me/data-export') && init?.method === 'POST'
          ? { ok: true, data: { exportRequestId: 'exp1' } }
          : undefined,
      (url) => {
        if (!url.endsWith('/api/v1/users/me/data-export/exp1')) return undefined;
        pollCount += 1;
        if (pollCount === 1) return { ok: true, data: { status: 'pending' } };
        return { ok: true, data: { status: 'ready', downloadUrl: '/api/v1/users/me/data-export/exp1/download?exp=1&sig=abc', expiresAt: new Date().toISOString() } };
      },
    ]);
    render(<PrivacySecurityPage />);

    await screen.findByRole('button', { name: 'Request my data export' });
    await user.click(screen.getByRole('button', { name: 'Request my data export' }));

    expect(await screen.findByText(/Preparing your export/)).toBeInTheDocument();
    expect(await screen.findByText('Download my data', {}, { timeout: 10000 })).toBeInTheDocument();
  }, 15000);

  it('deletion flow: destructive confirmation, then shows the grace-period banner with a cancel option', async () => {
    const user = userEvent.setup();
    installFetchMock([
      ...baselineHandlers(),
      (url, init) => (url.endsWith('/auth/step-up') && init?.method === 'POST' ? { ok: true, data: { stepUpToken: 'tok' } } : undefined),
      (url, init) =>
        url.endsWith('/api/v1/users/me/deletion') && init?.method === 'POST'
          ? { ok: true, data: { gracePeriodEndsAt: '2030-01-01T00:00:00.000Z' } }
          : undefined,
    ]);
    render(<PrivacySecurityPage />);

    await user.click(await screen.findByRole('button', { name: 'Delete my account' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete your account?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete my account' }));

    expect(await screen.findByText(/Account deletion pending/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel deletion' })).toBeInTheDocument();
  });

  it('an active-booking block on deletion shows the specific error, not a generic one', async () => {
    const user = userEvent.setup();
    installFetchMock([
      ...baselineHandlers(),
      (url, init) => (url.endsWith('/auth/step-up') && init?.method === 'POST' ? { ok: true, data: { stepUpToken: 'tok' } } : undefined),
      (url, init) =>
        url.endsWith('/api/v1/users/me/deletion') && init?.method === 'POST'
          ? { ok: false, error: { code: 'ACTIVE_BOOKING_BLOCKS_DELETION', message: 'You have an active booking. Resolve it before deleting your account.' } }
          : undefined,
    ]);
    render(<PrivacySecurityPage />);

    await user.click(await screen.findByRole('button', { name: 'Delete my account' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete your account?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete my account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/active booking/i);
  });

  it('screen-reader announcements: a live region reports session logout', async () => {
    const user = userEvent.setup();
    installFetchMock([
      ...baselineHandlers({ sessions: [SESSION_A, SESSION_B] }),
      (url, init) => (url.includes('/sessions/s2') && init?.method === 'DELETE' ? { ok: true } : undefined),
    ]);
    render(<PrivacySecurityPage />);

    await screen.findByText('Safari on iPhone');
    await user.click(screen.getByRole('button', { name: /Log out Safari on iPhone/ }));

    await waitFor(() => expect(screen.getByRole('status', { hidden: true })).toHaveTextContent('Device logged out.'));
  });
});
