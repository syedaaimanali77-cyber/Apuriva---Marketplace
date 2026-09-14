// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestMessageThread } from './RequestMessageThread';
import type { OfferMessageDto } from '@/lib/types/negotiation';

const LIST_URL = '/api/v1/requests/req-1/message-threads/prov-1/messages';

const MESSAGE: OfferMessageDto = {
  id: 'msg-1',
  requestId: 'req-1',
  providerProfileId: 'prov-1',
  offerId: null,
  kind: 'message',
  senderRole: 'provider',
  body: 'Which floor is the unit on?',
  contactRedacted: false,
  proposedPrice: null,
  createdAt: '2026-09-14T10:00:00.000Z',
};

function json(ok: boolean, body: unknown, status = ok ? 200 : 422, retryAfter: string | null = null) {
  return { ok, status, json: async () => body, headers: { get: (name: string) => (name === 'Retry-After' ? retryAfter : null) } };
}

function stubFetch(options?: { messages?: OfferMessageDto[]; post?: ReturnType<typeof json> }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === 'POST') {
      return Promise.resolve(
        options?.post ?? json(true, { data: { ...MESSAGE, id: 'msg-new', senderRole: 'customer', body: 'Second floor.' } }, 201),
      );
    }
    return Promise.resolve(json(true, { data: options?.messages ?? [MESSAGE] }));
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

function renderThread(overrides?: Partial<Parameters<typeof RequestMessageThread>[0]>) {
  render(
    <RequestMessageThread
      listUrl={LIST_URL}
      postUrl={LIST_URL}
      viewerRole="customer"
      counterpartyLabel="Ali Plumbing"
      closedMessage="This conversation closed when you selected a provider."
      {...overrides}
    />,
  );
}

describe('RequestMessageThread (spec 019 §5, AC-1/AC-7/AC-8)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the thread with the counterparty label and the viewer’s own messages as "You"', async () => {
    stubFetch({
      messages: [MESSAGE, { ...MESSAGE, id: 'msg-2', senderRole: 'customer', body: 'Second floor.' }],
    });
    renderThread();

    expect(await screen.findByText('Which floor is the unit on?')).toBeInTheDocument();
    expect(screen.getByText('Second floor.')).toBeInTheDocument();
    expect(screen.getByText('Ali Plumbing')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('shows the empty prompt when there are no messages yet', async () => {
    stubFetch({ messages: [] });
    renderThread();
    expect(await screen.findByText('No messages yet — ask a question about this request.')).toBeInTheDocument();
  });

  it('sends with a fresh Idempotency-Key and appends the server’s message', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ messages: [] });
    renderThread();
    await screen.findByText('No messages yet — ask a question about this request.');

    await user.type(screen.getByLabelText(/Your message/), 'Second floor.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Second floor.')).toBeInTheDocument();
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(post.url).toBe(LIST_URL);
    expect((post.init!.headers as Record<string, string>)['Idempotency-Key']).toEqual(expect.any(String));
    expect(JSON.parse(post.init!.body as string)).toEqual({ body: 'Second floor.' });
    // The composer is cleared after a successful send.
    expect(screen.getByLabelText(/Your message/)).toHaveValue('');
  });

  it('warns when the server reports that contact details were removed', async () => {
    const user = userEvent.setup();
    stubFetch({
      messages: [],
      post: json(true, { data: { ...MESSAGE, id: 'msg-red', senderRole: 'customer', body: 'Call [contact removed]', contactRedacted: true } }, 201),
    });
    renderThread();
    await screen.findByText('No messages yet — ask a question about this request.');

    await user.type(screen.getByLabelText(/Your message/), 'Call 03001234567');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('Contact details were removed — keep communication on APURIVA.')).toBeInTheDocument();
    expect(screen.getByText('Call [contact removed]')).toBeInTheDocument();
  });

  it('shows the remaining cooldown from Retry-After and keeps the drafted text on a rate-limited send', async () => {
    const user = userEvent.setup();
    stubFetch({ messages: [], post: json(false, { code: 'RATE_LIMITED', message: 'slow down' }, 429, '42') });
    renderThread();
    await screen.findByText('No messages yet — ask a question about this request.');

    await user.type(screen.getByLabelText(/Your message/), 'One too many');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('You can send another message in 42 s.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Your message/)).toHaveValue('One too many');
  });

  it('hides the composer when closed and keeps drafted text on send failure', async () => {
    const user = userEvent.setup();
    stubFetch({ messages: [], post: json(false, { code: 'THREAD_CLOSED', message: 'closed' }, 422) });
    renderThread();
    await screen.findByText('No messages yet — ask a question about this request.');

    await user.type(screen.getByLabelText(/Your message/), 'Late message');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull());
    expect(screen.getByText('This conversation closed when you selected a provider.')).toBeInTheDocument();
  });

  it('renders no composer at all when the server already said the thread is closed', async () => {
    stubFetch({ messages: [MESSAGE] });
    renderThread({ canSend: false });
    await screen.findByText('Which floor is the unit on?');
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
    expect(screen.getByText('This conversation closed when you selected a provider.')).toBeInTheDocument();
  });

  it('marks a change request and shows its proposed price', async () => {
    stubFetch({
      messages: [
        {
          ...MESSAGE,
          id: 'msg-cr',
          kind: 'change_request',
          senderRole: 'customer',
          offerId: 'offer-1',
          body: 'Can you do Sunday?',
          proposedPrice: { amountMinorUnits: 250_000, currencyCode: 'PKR' },
        },
      ],
    });
    renderThread({ viewerRole: 'provider', counterpartyLabel: 'Customer' });

    expect(await screen.findByText('Can you do Sunday?')).toBeInTheDocument();
    expect(screen.getByText('Change requested')).toBeInTheDocument();
    expect(screen.getByText(/Proposed price/)).toBeInTheDocument();
  });

  it('keeps the drafted text and reports the error when a send fails for another reason', async () => {
    const user = userEvent.setup();
    stubFetch({ messages: [], post: json(false, { code: 'INTERNAL_ERROR', message: 'boom' }, 500) });
    renderThread();
    await screen.findByText('No messages yet — ask a question about this request.');

    await user.type(screen.getByLabelText(/Your message/), 'Draft survives');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText('boom')).toBeInTheDocument();
    expect(screen.getByLabelText(/Your message/)).toHaveValue('Draft survives');
  });

  it('shows the DS ErrorState when the thread cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(false, { code: 'INTERNAL_ERROR' }, 500))));
    renderThread();
    expect(await screen.findByText("Couldn't load this conversation.")).toBeInTheDocument();
  });
});
