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

  it('the phone tab is the default (primary path per §1)', () => {
    render(<LoginPage />);
    expect(screen.getByRole('tab', { name: 'Phone' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText(/^Phone number/)).toBeInTheDocument();
  });

  it('the OTP submit button is disabled until a phone number is entered', () => {
    render(<LoginPage />);
    expect(screen.getByRole('button', { name: 'Send code' })).toBeDisabled();
  });
});
