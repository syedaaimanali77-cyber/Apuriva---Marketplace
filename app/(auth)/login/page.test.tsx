// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './page';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

describe('LoginPage (spec 005 §5 UI states)', () => {
  beforeEach(() => {
    push.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AC-3: shows one generic error, never revealing whether the email exists', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ status: 401, code: 'UNAUTHENTICATED', message: 'Invalid email or password.', correlationId: 'x' }),
      }),
    );

    render(<LoginPage />);
    await user.click(screen.getByRole('tab', { name: 'Email' }));
    await user.type(screen.getByLabelText(/^Email/), 'someone@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't sign you in/i);
    expect(screen.queryByText(/exist/i)).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('redirects home on a successful password login', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { userId: 'u1', sessionId: 's1', expiresAt: '2030-01-01T00:00:00.000Z', mfaRequired: false, roles: [] },
          correlationId: 'x',
        }),
      }),
    );

    render(<LoginPage />);
    await user.click(screen.getByRole('tab', { name: 'Email' }));
    await user.type(screen.getByLabelText(/^Email/), 'someone@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
  });

  it('AC-5: shows the MFA step instead of redirecting when mfaRequired is true', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { userId: 'u1', sessionId: 's1', expiresAt: '2030-01-01T00:00:00.000Z', mfaRequired: true, roles: ['admin'] },
          correlationId: 'x',
        }),
      }),
    );

    render(<LoginPage />);
    await user.click(screen.getByRole('tab', { name: 'Email' }));
    await user.type(screen.getByLabelText(/^Email/), 'admin@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByLabelText('Authenticator code')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('AC-5: an admin who has never enrolled sets up an authenticator first, and the first code completes it', async () => {
    const user = userEvent.setup();
    const reply = (data: unknown) => ({ ok: true, json: async () => ({ data, correlationId: 'x' }) });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        reply({ userId: 'u1', sessionId: 's1', expiresAt: '2030-01-01T00:00:00.000Z', mfaRequired: true, mfaEnrollmentRequired: true, roles: ['admin'] }),
      )
      .mockResolvedValueOnce(
        reply({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauthUrl: 'otpauth://totp/Apuriva:admin%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', enrollmentToken: 'enrol-token', expiresAt: '2030-01-01T00:10:00.000Z' }),
      )
      .mockResolvedValueOnce(reply({ userId: 'u1', sessionId: 's1', expiresAt: '2030-01-01T00:00:00.000Z', mfaRequired: false, roles: ['admin'] }));
    vi.stubGlobal('fetch', fetchMock);

    render(<LoginPage />);
    await user.click(screen.getByRole('tab', { name: 'Email' }));
    await user.type(screen.getByLabelText(/^Email/), 'admin@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('heading', { name: 'Set up two-factor authentication' })).toBeInTheDocument();
    expect(await screen.findByTestId('mfa-setup-key')).toHaveTextContent('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
    expect(screen.getByRole('link', { name: 'Open in authenticator app' })).toHaveAttribute('href', expect.stringMatching(/^otpauth:\/\/totp\//));
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/v1/auth/mfa/enrollment');

    await user.type(screen.getByLabelText('Authenticator code'), '123456');
    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
    const [url, init] = fetchMock.mock.calls[2]!;
    expect(url).toBe('/api/v1/auth/mfa/verify');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ code: '123456', enrollmentToken: 'enrol-token' });
  });

  it('the phone tab is the default (primary path per §1)', () => {
    render(<LoginPage />);
    expect(screen.getByRole('tab', { name: 'Phone' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText(/^Phone number/)).toBeInTheDocument();
  });

  it('the OTP submit button is disabled until a phone number is entered', () => {
    render(<LoginPage />);
    expect(screen.getByRole('button', { name: 'Send code' })).toBeDisabled();
  });

  it('AC-4: Google and Apple stay disabled, with plain user-facing copy (no internal spec or sandbox text)', () => {
    render(<LoginPage />);
    for (const name of ['Continue with Google', 'Continue with Apple']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'Not available yet.');
      expect(button.getAttribute('title')).not.toMatch(/spec|sandbox|credential|risk/i);
    }
  });
});
