// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setOnline } from '@/app/_components/network-test-support';
import { en } from '@/lib/i18n/dictionaries/en';
import { ConfirmBookingPanel } from './ConfirmBookingPanel';

/** Spec 044 §3.5 (AC-2, AC-3, X-5) — booking confirmation is disabled offline; nothing is sent or shown as booked. */
describe('ConfirmBookingPanel offline (spec 044 §3.5)', () => {
  afterEach(() => {
    setOnline(true);
    vi.unstubAllGlobals();
  });

  it('disables the confirm button with the offline notice, sends nothing, and re-enables on reconnect', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setOnline(false);
    render(<ConfirmBookingPanel offerId="offer-1" />);
    const confirm = screen.getByRole('button', { name: en.bookingParts.confirm.button });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAccessibleDescription(en.errors.NETWORK_ERROR);

    await userEvent.click(confirm);
    expect(fetchMock).not.toHaveBeenCalled();

    setOnline(true);
    expect(confirm).toBeEnabled();
  });
});
