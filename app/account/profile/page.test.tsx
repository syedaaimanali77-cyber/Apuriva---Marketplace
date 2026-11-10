// @vitest-environment jsdom
import { configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/dictionaries/en';
import ProfilePage from './page';

configure({ asyncUtilTimeout: 10_000 });

const CUSTOMER = { id: 'user-1', hasCustomerProfile: true, hasProviderProfile: false, activeMode: 'customer', isAdmin: false, locale: null };
const PROFILE = { displayName: 'Ayesha', email: 'ayesha@example.com', emailVerified: true, phoneNumber: null, phoneVerified: false, version: 3 };

const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ data }) });
const fail = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

interface Handlers {
  me?: unknown;
  profile?: () => unknown;
  business?: () => unknown;
  patchProfile?: (body: Record<string, unknown>) => unknown;
  patchBusiness?: (body: Record<string, unknown>) => unknown;
}

function stub(h: Handlers) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith('/api/v1/users/me')) return ok(h.me ?? CUSTOMER);
      if (url.endsWith('/users/me/profile')) return method === 'PATCH' ? h.patchProfile!(body!) : (h.profile?.() ?? ok(PROFILE));
      if (url.endsWith('/providers/me/profile')) return method === 'PATCH' ? h.patchBusiness!(body!) : (h.business?.() ?? ok({ businessName: 'Ali Plumbing', version: 2 }));
      return ok({});
    }),
  );
  return calls;
}

describe('Account → Profile page', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the display name to edit, and email/phone read-only with their verified state', async () => {
    stub({});
    render(<ProfilePage />);
    expect(await screen.findByLabelText(en.accountProfile.displayName)).toHaveValue('Ayesha');
    expect(screen.getByText('ayesha@example.com')).toBeInTheDocument();
    expect(screen.getByText(en.accountProfile.verified)).toBeInTheDocument();
    expect(screen.getByText(en.accountProfile.notSet)).toBeInTheDocument(); // no phone
    expect(screen.getByText(en.accountProfile.contactReadOnly)).toBeInTheDocument();
    // Email and phone are not editable.
    expect(screen.queryByDisplayValue('ayesha@example.com')).not.toBeInTheDocument();
    // No business section for an account without a provider profile.
    expect(screen.queryByText(en.accountProfile.businessHeading)).not.toBeInTheDocument();
  });

  it('saves the trimmed name with expectedVersion, and shows it saved only after the server confirms', async () => {
    const calls = stub({ patchProfile: (body) => ok({ ...PROFILE, displayName: body.displayName, version: 4 }) });
    render(<ProfilePage />);
    const input = await screen.findByLabelText(en.accountProfile.displayName);
    await userEvent.clear(input);
    await userEvent.type(input, '  عائشہ  ');
    await userEvent.click(screen.getByRole('button', { name: en.accountProfile.save }));

    expect(await screen.findByRole('status')).toHaveTextContent(en.accountProfile.saved);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ displayName: 'عائشہ', expectedVersion: 3 });
    expect(screen.getByLabelText(en.accountProfile.displayName)).toHaveValue('عائشہ');
  });

  it('an empty name clears it (sends null)', async () => {
    const calls = stub({ patchProfile: () => ok({ ...PROFILE, displayName: null, version: 4 }) });
    render(<ProfilePage />);
    await userEvent.clear(await screen.findByLabelText(en.accountProfile.displayName));
    await userEvent.click(screen.getByRole('button', { name: en.accountProfile.save }));
    await screen.findByRole('status');
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ displayName: null, expectedVersion: 3 });
  });

  it('limits the input to 60 characters', async () => {
    stub({});
    render(<ProfilePage />);
    expect(await screen.findByLabelText(en.accountProfile.displayName)).toHaveAttribute('maxLength', '60');
  });

  it('shows a server validation error against the field and never says saved', async () => {
    stub({
      patchProfile: () => fail(400, { code: 'VALIDATION_ERROR', message: 'Invalid', errors: [{ field: 'displayName', message: 'must not contain control characters' }] }),
    });
    render(<ProfilePage />);
    await userEvent.type(await screen.findByLabelText(en.accountProfile.displayName), 'x');
    await userEvent.click(screen.getByRole('button', { name: en.accountProfile.save }));
    expect(await screen.findByText(en.accountProfile.invalidName)).toBeInTheDocument();
    expect(screen.queryByText(en.accountProfile.saved)).not.toBeInTheDocument();
  });

  it('on a stale version it reloads the latest profile and explains, rather than overwriting', async () => {
    let reads = 0;
    stub({
      profile: () => ok(++reads === 1 ? PROFILE : { ...PROFILE, displayName: 'Changed elsewhere', version: 5 }),
      patchProfile: () => fail(409, { code: 'CONFLICT', message: 'stale' }),
    });
    render(<ProfilePage />);
    await userEvent.type(await screen.findByLabelText(en.accountProfile.displayName), '!');
    await userEvent.click(screen.getByRole('button', { name: en.accountProfile.save }));
    expect(await screen.findByText(en.accountProfile.staleVersion)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(en.accountProfile.displayName)).toHaveValue('Changed elsewhere'));
  });

  it('in provider mode, edits the business name through the provider route', async () => {
    const calls = stub({
      me: { ...CUSTOMER, hasProviderProfile: true, activeMode: 'provider' },
      patchBusiness: (body) => ok({ businessName: body.businessName, version: 3 }),
    });
    render(<ProfilePage />);
    const input = await screen.findByLabelText(en.accountProfile.businessName);
    expect(input).toHaveValue('Ali Plumbing');
    await userEvent.clear(input);
    await userEvent.type(input, 'Ali Plumbing & Sons');
    await userEvent.click(screen.getAllByRole('button', { name: en.accountProfile.save })[1]!);
    await screen.findByText(en.accountProfile.saved);
    expect(calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/providers/me/profile'))!.body).toEqual({ businessName: 'Ali Plumbing & Sons', expectedVersion: 2 });
  });

  it('with a provider profile but in customer mode, explains that provider mode is needed and calls no provider route', async () => {
    const calls = stub({ me: { ...CUSTOMER, hasProviderProfile: true, activeMode: 'customer' } });
    render(<ProfilePage />);
    expect(await screen.findByText(en.accountProfile.businessProviderModeOnly)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/providers/me/profile'))).toBe(false);
  });

  it('shows the error state with retry when the profile cannot be loaded', async () => {
    stub({ profile: () => fail(500, { code: 'INTERNAL_ERROR', message: 'boom' }) });
    render(<ProfilePage />);
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
