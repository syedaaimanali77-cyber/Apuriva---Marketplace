// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/dictionaries/en';
import { setOnline } from './network-test-support';
import { RequestMessageThread } from './RequestMessageThread';

/** Spec 044 §3.5 (AC-3, X-5) — message send is disabled while offline, with the offline notice; nothing is queued. */
const URL_ = '/api/v1/requests/req-1/message-threads/prov-1/messages';

describe('RequestMessageThread offline (spec 044 §3.5)', () => {
  afterEach(() => {
    setOnline(true);
    vi.unstubAllGlobals();
  });

  it('disables Send with the offline notice as its description, sends nothing, and re-enables on reconnect', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>(async () => ({ ok: true, status: 200, json: async () => ({ data: [] }), headers: { get: () => null } }));
    vi.stubGlobal('fetch', fetchMock);
    setOnline(true);
    render(<RequestMessageThread listUrl={URL_} postUrl={URL_} viewerRole="customer" counterpartyLabel="Ali Plumbing" closedMessage="closed" />);
    // The live control is re-queried each time: the thread may re-render its composer after loading.
    const send = () => screen.getByRole('button', { name: en.thread.send });
    await waitFor(() => expect(send()).toBeEnabled());

    setOnline(false);
    await waitFor(() => expect(send()).toBeDisabled());
    expect(send()).toHaveAccessibleDescription(en.errors.NETWORK_ERROR);

    await userEvent.type(screen.getByLabelText(en.thread.yourMessage), 'Second floor.');
    await userEvent.click(send());
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);

    setOnline(true);
    await waitFor(() => expect(send()).toBeEnabled());
    expect(send()).not.toHaveAccessibleDescription(en.errors.NETWORK_ERROR);
  });
});
