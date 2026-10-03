// @vitest-environment jsdom
import { configure, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setOnline } from '@/app/_components/network-test-support';
import { en } from '@/lib/i18n/dictionaries/en';
import { BookingConversation } from './BookingConversation';

configure({ asyncUtilTimeout: 10_000 });

/**
 * Spec 044 §3.5 (AC-3, X-5) — the booking conversation's composer is RequestMessageThread's, so its Send is
 * disabled offline the same way.
 */
describe('BookingConversation offline (spec 044 §3.5)', () => {
  afterEach(() => {
    setOnline(true);
    vi.unstubAllGlobals();
  });

  it('disables Send while offline, with the offline notice', async () => {
    const conversation = {
      id: 'conversation-1',
      bookingId: 'booking-1',
      participants: [
        { userId: 'c', role: 'customer', displayName: null, lastReadAt: null },
        { userId: 'p', role: 'provider', displayName: 'Ali Plumbing', lastReadAt: null },
      ],
      isActive: true,
      archivedAt: null,
      contactSharingAllowed: true,
      messageCount: 0,
      lastMessageAt: null,
      unreadCount: 0,
      createdAt: '2026-09-17T09:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        json: async () => (url.includes('/messages') ? { data: [], page: { limit: 100, offset: 0, total: 0, nextOffset: null } } : { data: conversation }),
        headers: { get: () => null },
      })),
    );
    setOnline(true);
    render(<BookingConversation bookingId="booking-1" viewerRole="customer" />);
    // The live control is re-queried each time: the conversation may re-render its composer after loading.
    const send = () => screen.getByRole('button', { name: en.thread.send });
    await waitFor(() => expect(send()).toBeEnabled());

    setOnline(false);
    await waitFor(() => expect(send()).toBeDisabled());
    expect(send()).toHaveAccessibleDescription(en.errors.NETWORK_ERROR);
  });
});
