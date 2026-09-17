// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, configure, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BookingConversation } from './BookingConversation';
import type { ConversationDto, MessageDto } from '@/lib/types/messaging';

// The first render waits on a summary fetch and a history fetch; under full-suite CPU contention that can
// exceed Testing Library's 1s default (the same allowance app/account/privacy-security/page.test.tsx makes).
configure({ asyncUtilTimeout: 10_000 });

const CONVERSATION: ConversationDto = {
  id: 'c-1',
  bookingId: 'b-1',
  participants: [
    { userId: 'u-c', role: 'customer', displayName: null, lastReadAt: null },
    { userId: 'u-p', role: 'provider', displayName: 'Ali Plumbing', lastReadAt: null },
  ],
  isActive: true,
  archivedAt: null,
  contactSharingAllowed: true,
  messageCount: 1,
  lastMessageAt: null,
  unreadCount: 0,
  createdAt: '2026-09-17T09:00:00.000Z',
};

function msg(id: string, body: string, createdAt: string, senderRole: 'customer' | 'provider' = 'provider'): MessageDto {
  return {
    id,
    conversationId: 'c-1',
    senderUserId: senderRole === 'provider' ? 'u-p' : 'u-c',
    senderRole,
    body,
    contactRedacted: false,
    contactFlagged: false,
    readByCounterpartyAt: null,
    redactedByRetention: false,
    createdAt,
  };
}

function stub(options: { history: MessageDto[]; delta?: MessageDto[][]; sent?: MessageDto }) {
  const deltas = [...(options.delta ?? [])];
  const posts: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      let body: unknown;
      let status = 200;
      if (init?.method === 'POST' && url.endsWith('/read')) body = { data: {} };
      else if (init?.method === 'POST') {
        posts.push(init);
        status = 201;
        body = { data: options.sent };
      } else if (url.includes('after=')) body = { data: deltas.shift() ?? [], page: { nextOffset: null } };
      else if (url.includes('/messages')) body = { data: options.history, page: { nextOffset: null } };
      else body = { data: CONVERSATION };
      return { ok: true, status, json: async () => body, headers: { get: () => null } };
    }),
  );
  return { posts };
}

/** Spec 025 §5 "Accessibility" and "RTL" — spec 043's baseline applied to the booking conversation. */
describe('BookingConversation accessibility (spec 025 §5)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is fully keyboard operable: labelled composer, Enter adds a newline, Tab reaches a real send button', async () => {
    const user = userEvent.setup();
    const { posts } = stub({ history: [], sent: msg('s-1', 'Line one\nLine two', '2026-09-17T09:10:00.000Z', 'customer') });
    render(<BookingConversation bookingId="b-1" viewerRole="customer" />);
    await screen.findByText('No messages yet — say hello');

    const composer = screen.getByRole('textbox', { name: /Your message/ });
    await user.click(composer);
    await user.keyboard('Line one{Enter}Line two');
    expect(composer).toHaveValue('Line one\nLine two');
    expect(posts).toHaveLength(0); // Enter never sends by itself

    await user.tab();
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(send).toHaveFocus();
    expect(send.tagName).toBe('BUTTON');
    await user.keyboard('{Enter}');

    expect(await screen.findByText(/Line one/)).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(screen.getByRole('form', { name: 'Message Ali Plumbing' })).toBeInTheDocument();
  });

  it('exposes the thread as a labelled list with each sender and time available to assistive technology', async () => {
    stub({ history: [msg('m-1', 'On my way', '2026-09-17T09:01:00.000Z'), msg('m-2', 'Thanks', '2026-09-17T09:02:00.000Z', 'customer')] });
    render(<BookingConversation bookingId="b-1" viewerRole="customer" />);

    const list = await screen.findByRole('list', { name: 'Conversation with Ali Plumbing' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Ali Plumbing');
    expect(items[0]).toHaveTextContent(new Date('2026-09-17T09:01:00.000Z').toLocaleString());
    expect(items[1]).toHaveTextContent('You');
  });

  it('announces new incoming messages through a polite live region as an aggregate, never their bodies, without moving focus', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    stub({
      history: [msg('m-1', 'Hello', '2026-09-17T09:01:00.000Z')],
      delta: [[msg('m-2', 'Secret gate code 4471', '2026-09-17T09:02:00.000Z'), msg('m-3', 'Parking now', '2026-09-17T09:03:00.000Z')]],
    });
    render(<BookingConversation bookingId="b-1" viewerRole="customer" />);
    await screen.findByText('Hello');

    const composer = screen.getByRole('textbox', { name: /Your message/ });
    await user.click(composer);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await screen.findByText('Parking now');

    const live = screen.getAllByRole('status').find((node) => node.getAttribute('aria-live') === 'polite')!;
    expect(live).toHaveTextContent('2 new messages from Ali Plumbing');
    expect(live).not.toHaveTextContent('Secret gate code');
    expect(composer).toHaveFocus();
  });

  it('uses logical properties only, so an Urdu (RTL) conversation mirrors correctly', () => {
    const css = readFileSync(path.resolve(__dirname, '../../_components/request-message-thread.module.css'), 'utf8');
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toMatch(/(^|[\s;{])(margin|padding|border)-(left|right)\s*:/m);
    expect(declarations).not.toMatch(/(^|[\s;{])(left|right)\s*:/m);
    expect(declarations).not.toMatch(/text-align\s*:\s*(left|right)/);
    expect(declarations).not.toMatch(/float\s*:\s*(left|right)/);
  });
});
