// @vitest-environment jsdom
import { act, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BookingConversation } from './BookingConversation';
import type { ConversationDto, MessageDto } from '@/lib/types/messaging';

// The first render waits on a summary fetch and a history fetch; under full-suite CPU contention that can
// exceed Testing Library's 1s default (the same allowance app/account/privacy-security/page.test.tsx makes).
configure({ asyncUtilTimeout: 10_000 });

const BOOKING_ID = 'booking-1';
const BASE = `/api/v1/bookings/${BOOKING_ID}/conversation`;
const CUSTOMER_ID = 'user-customer';
const PROVIDER_ID = 'user-provider';

function conversation(overrides?: Partial<ConversationDto>): ConversationDto {
  return {
    id: 'conversation-1',
    bookingId: BOOKING_ID,
    participants: [
      { userId: CUSTOMER_ID, role: 'customer', displayName: null, lastReadAt: null },
      { userId: PROVIDER_ID, role: 'provider', displayName: 'Ali Plumbing', lastReadAt: null },
    ],
    isActive: true,
    archivedAt: null,
    contactSharingAllowed: true,
    messageCount: 0,
    lastMessageAt: null,
    unreadCount: 0,
    createdAt: '2026-09-17T09:00:00.000Z',
    ...overrides,
  };
}

function message(overrides?: Partial<MessageDto>): MessageDto {
  return {
    id: 'msg-1',
    conversationId: 'conversation-1',
    senderUserId: PROVIDER_ID,
    senderRole: 'provider',
    body: 'On my way',
    contactRedacted: false,
    contactFlagged: false,
    readByCounterpartyAt: null,
    redactedByRetention: false,
    createdAt: '2026-09-17T09:01:00.000Z',
    ...overrides,
  };
}

type Reply = { ok: boolean; status: number; body: unknown; retryAfter?: string };
const ok = (body: unknown, status = 200): Reply => ({ ok: true, status, body });
const fail = (status: number, body: unknown, retryAfter?: string): Reply => ({ ok: false, status, body, retryAfter });

interface Handlers {
  conversation?: () => Reply;
  history?: () => Reply;
  delta?: (url: string) => Reply;
  send?: (init: RequestInit) => Reply;
  read?: (init: RequestInit) => Reply;
}

function stubFetch(handlers: Handlers) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    let reply: Reply;
    if (init?.method === 'POST' && url.endsWith('/read')) reply = handlers.read?.(init) ?? ok({ data: {} });
    else if (init?.method === 'POST') reply = handlers.send?.(init) ?? ok({ data: message() }, 201);
    else if (url.includes('after=')) reply = handlers.delta?.(url) ?? ok({ data: [], page: { limit: 50, offset: 0, total: 0, nextOffset: null } });
    else if (url.includes('/messages')) reply = handlers.history?.() ?? ok({ data: [], page: { limit: 100, offset: 0, total: 0, nextOffset: null } });
    else reply = handlers.conversation?.() ?? ok({ data: conversation() });
    return {
      ok: reply.ok,
      status: reply.status,
      json: async () => reply.body,
      headers: { get: (name: string) => (name === 'Retry-After' ? (reply.retryAfter ?? null) : null) },
    };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const history = (messages: MessageDto[]) => () =>
  ok({ data: messages, page: { limit: 100, offset: 0, total: messages.length, nextOffset: null } });

describe('BookingConversation (spec 025 §5)', () => {
  beforeEach(() => {
    let n = 0;
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => `key-${++n}` });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows the loading skeleton, then the empty state with the pre-confirmation guidance', async () => {
    stubFetch({ conversation: () => ok({ data: conversation({ contactSharingAllowed: false }) }) });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="customer" />);

    expect(screen.getByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    expect(await screen.findByText('No messages yet — say hello')).toBeInTheDocument();
    expect(screen.getAllByText('Phone numbers and emails are hidden until this booking is confirmed.').length).toBeGreaterThan(0);
  });

  it('shows an error state with retry when the conversation cannot be loaded', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    stubFetch({ conversation: () => (++attempts === 1 ? fail(500, { code: 'INTERNAL_ERROR' }) : ok({ data: conversation() })) });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="customer" />);

    expect(await screen.findByText("Couldn't load this conversation.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(await screen.findByText('No messages yet — say hello')).toBeInTheDocument();
  });

  it('a network failure (fetch rejects) lands in the error state instead of an endless skeleton, and retry recovers', async () => {
    const user = userEvent.setup();
    const { fn } = stubFetch({});
    const fallback = fn.getMockImplementation()!;
    let rejected = false;
    fn.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!rejected && !url.includes('/messages')) {
        rejected = true;
        throw new TypeError('Failed to fetch');
      }
      return fallback(url, init);
    });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="customer" />);

    expect(await screen.findByText("Couldn't load this conversation.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(await screen.findByText('No messages yet — say hello')).toBeInTheDocument();
  });

  it('renders history with the counterparty name and marks the newest counterparty message read', async () => {
    const { calls } = stubFetch({
      history: history([message(), message({ id: 'msg-2', senderUserId: CUSTOMER_ID, senderRole: 'customer', body: 'Great', createdAt: '2026-09-17T09:02:00.000Z' })]),
    });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="customer" />);

    expect(await screen.findByText('On my way')).toBeInTheDocument();
    expect(screen.getByText('Ali Plumbing')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();

    await waitFor(() => expect(calls.some((c) => c.url === `${BASE}/read`)).toBe(true));
    const read = calls.find((c) => c.url === `${BASE}/read`)!;
    expect(JSON.parse(read.init!.body as string)).toEqual({ lastReadMessageId: 'msg-1' });
  });

  it('renders no message before server confirmation, then the confirmed message', async () => {
    const user = userEvent.setup();
    let release: (reply: Reply) => void = () => undefined;
    const pending = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const { fn } = stubFetch({});
    fn.mockImplementation(async (url: string, init?: RequestInit) => {
      const reply =
        init?.method === 'POST'
          ? await pending
          : url.includes('/messages')
            ? ok({ data: [], page: { limit: 100, offset: 0, total: 0, nextOffset: null } })
            : ok({ data: conversation() });
      return { ok: reply.ok, status: reply.status, json: async () => reply.body, headers: { get: () => null } };
    });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="customer" />);
    await screen.findByText('No messages yet — say hello');

    await user.type(screen.getByLabelText(/Your message/), 'Gate code 4471');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    // Still pending: nothing optimistic is rendered.
    expect(screen.queryByRole('listitem')).toBeNull();

    await act(async () => {
      release(ok({ data: message({ id: 'msg-sent', senderRole: 'customer', senderUserId: CUSTOMER_ID, body: 'Gate code 4471' }) }, 201));
    });
    expect(await screen.findByText('Gate code 4471')).toBeInTheDocument();
    expect(screen.getByLabelText(/Your message/)).toHaveValue('');
  });

  it('failed send keeps draft and key; a retry reuses the key, an edit gets a new one', async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    let attempt = 0;
    stubFetch({
      send: (init) => {
        keys.push((init.headers as Record<string, string>)['Idempotency-Key']!);
        attempt += 1;
        return attempt < 3 ? fail(500, { code: 'INTERNAL_ERROR', message: 'Network trouble' }) : ok({ data: message({ id: 'm', senderRole: 'customer', body: 'Hello!' }) }, 201);
      },
    });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="customer" />);
    await screen.findByText('No messages yet — say hello');

    await user.type(screen.getByLabelText(/Your message/), 'Hello');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('Network trouble')).toBeInTheDocument();
    expect(screen.getByLabelText(/Your message/)).toHaveValue('Hello');

    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);

    await user.type(screen.getByLabelText(/Your message/), '!');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[0]);
    expect(await screen.findByText('Hello!')).toBeInTheDocument();
  });

  it('shows the redaction notice when the server masked contact details', async () => {
    const user = userEvent.setup();
    stubFetch({
      conversation: () => ok({ data: conversation({ contactSharingAllowed: false }) }),
      send: () => ok({ data: message({ id: 'r', senderRole: 'customer', body: 'Call [contact removed]', contactRedacted: true }) }, 201),
    });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="customer" />);
    await screen.findByText('No messages yet — say hello');

    await user.type(screen.getByLabelText(/Your message/), 'Call 03001234567');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText(/We hid a phone number or email/)).toBeInTheDocument();
    expect(screen.getByText('Call [contact removed]')).toBeInTheDocument();
  });

  it('blocked: disables the composer with an explanation and keeps history visible', async () => {
    const user = userEvent.setup();
    stubFetch({ history: history([message()]), send: () => fail(403, { code: 'BLOCKED', message: 'blocked' }) });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="customer" />);
    await screen.findByText('On my way');

    await user.type(screen.getByLabelText(/Your message/), 'Hello?');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(await screen.findByText(/You can no longer send messages in this conversation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
    expect(screen.getByText('On my way')).toBeInTheDocument();
  });

  it('archived: read-only with history and no composer', async () => {
    stubFetch({ conversation: () => ok({ data: conversation({ isActive: false, archivedAt: '2026-09-17T12:00:00.000Z' }) }), history: history([message()]) });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="customer" />);

    expect(await screen.findByText('On my way')).toBeInTheDocument();
    expect(screen.getByText(/this conversation is read-only/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeNull();
  });

  it('a 429 on send shows the Retry-After wait and keeps the draft', async () => {
    const user = userEvent.setup();
    stubFetch({ send: () => fail(429, { code: 'RATE_LIMITED', message: 'slow' }, '12') });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="provider" />);
    await screen.findByText('No messages yet — say hello');

    await user.type(screen.getByLabelText(/Your message/), 'Arrived');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByText('You can send another message in 12 s.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Your message/)).toHaveValue('Arrived');
  });

  it('polls with the cursor delta every 5 seconds and appends new counterparty messages', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = message();
    const later = message({ id: 'msg-late', body: 'Parking now', createdAt: '2026-09-17T09:05:00.000Z' });
    const deltaUrls: string[] = [];
    let served = false;
    stubFetch({
      history: history([first]),
      delta: (url) => {
        deltaUrls.push(url);
        if (served) return ok({ data: [], page: { limit: 50, offset: 0, total: 0, nextOffset: null } });
        served = true;
        return ok({ data: [later], page: { limit: 50, offset: 0, total: 1, nextOffset: null } });
      },
    });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="customer" />);
    await screen.findByText('On my way');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(await screen.findByText('Parking now')).toBeInTheDocument();
    expect(deltaUrls[0]).toContain(`after=${encodeURIComponent(`${first.createdAt}|${first.id}`)}`);
    expect(deltaUrls[0]).toContain('limit=50');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(deltaUrls[1]).toContain(`after=${encodeURIComponent(`${later.createdAt}|${later.id}`)}`);
    // Exactly once in the list: the resumed read never duplicates.
    expect(screen.getAllByText('Parking now')).toHaveLength(1);
  });

  it('a failed poll keeps history, shows reconnecting, and resumes from the same cursor', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = message();
    const deltaUrls: string[] = [];
    let failures = 1;
    stubFetch({
      history: history([first]),
      delta: (url) => {
        deltaUrls.push(url);
        if (failures-- > 0) return fail(500, { code: 'INTERNAL_ERROR' });
        return ok({ data: [], page: { limit: 50, offset: 0, total: 0, nextOffset: null } });
      },
    });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="customer" />);
    await screen.findByText('On my way');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(await screen.findByText(/Reconnecting/)).toBeInTheDocument();
    expect(screen.getByText('On my way')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await waitFor(() => expect(screen.queryByText(/Reconnecting/)).toBeNull());
    expect(deltaUrls.length).toBeGreaterThanOrEqual(2);
    // Same cursor (no gap, no duplicate), and the recovered poll reports itself for observability.
    const cursorOf = (url: string) => new URL(url, 'http://localhost').searchParams.get('after');
    expect(cursorOf(deltaUrls[1]!)).toBe(cursorOf(deltaUrls[0]!));
    expect(deltaUrls[0]).not.toContain('resumed=');
    expect(deltaUrls[1]).toMatch(/[?&]resumed=1:\d+/);
    // Once recovered, later polls stop reporting it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(deltaUrls[deltaUrls.length - 1]).not.toContain('resumed=');
  });

  it('shows one quiet "Seen" on the viewer’s last message the counterparty has read', async () => {
    const own1 = message({ id: 'own-1', senderRole: 'customer', senderUserId: CUSTOMER_ID, body: 'First', createdAt: '2026-09-17T09:01:00.000Z' });
    const own2 = message({ id: 'own-2', senderRole: 'customer', senderUserId: CUSTOMER_ID, body: 'Second', createdAt: '2026-09-17T09:02:00.000Z' });
    const own3 = message({ id: 'own-3', senderRole: 'customer', senderUserId: CUSTOMER_ID, body: 'Third', createdAt: '2026-09-17T09:03:00.000Z' });
    stubFetch({
      conversation: () =>
        ok({
          data: conversation({
            participants: [
              { userId: CUSTOMER_ID, role: 'customer', displayName: null, lastReadAt: null },
              { userId: PROVIDER_ID, role: 'provider', displayName: 'Ali Plumbing', lastReadAt: '2026-09-17T09:02:00.000Z' },
            ],
          }),
        }),
      history: history([own1, own2, own3]),
    });
    render(<BookingConversation bookingId={BOOKING_ID} viewerRole="customer" />);
    await screen.findByText('Third');

    const seen = screen.getAllByText(/^Seen /);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.closest('li')).toHaveTextContent('Second');
  });
});
