// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RegisterPage from './page';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

describe('RegisterPage (spec 005 §5 UI states)', () => {
  beforeEach(() => {
    push.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a field-level error for a weak password', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          status: 400,
          code: 'VALIDATION_ERROR',
          message: 'The request failed validation.',
          errors: [{ field: 'password', message: 'must be at least 8 characters' }],
          correlationId: 'x',
        }),
      }),
    );

    render(<RegisterPage />);
    await user.type(screen.getByLabelText(/^Email/), 'someone@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('shows a clear message when the email is already registered', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({
          status: 409,
          code: 'CONFLICT',
          message: 'An account with this email already exists.',
          correlationId: 'x',
        }),
      }),
    );

    render(<RegisterPage />);
    await user.type(screen.getByLabelText(/^Email/), 'taken@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
  });

  it('redirects home on successful registration', async () => {
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

    render(<RegisterPage />);
    await user.type(screen.getByLabelText(/^Email/), 'someone@example.com');
    await user.type(screen.getByLabelText(/^Password/), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/'));
  });

  it('every field is reachable and typeable by keyboard', async () => {
    const user = userEvent.setup();
    render(<RegisterPage />);
    await user.tab();
    expect(screen.getByLabelText(/^Email/)).toHaveFocus();
    await user.keyboard('me@example.com');
    await user.tab();
    expect(screen.getByLabelText(/^Password/)).toHaveFocus();
  });
});
