// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfferCountdown } from './OfferCountdown';

const SERVER_NOW = '2026-09-14T10:00:00.000Z';
const EXPIRES_AT = '2026-09-14T10:02:00.000Z';

function secondsShown(): number {
  return Number(screen.getByTestId('offer-countdown').getAttribute('data-seconds-remaining'));
}

describe('OfferCountdown (spec 018 §5 — display only)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('derives the display from expiresAt - serverNow and counts down with elapsed time', () => {
    render(<OfferCountdown expiresAt={EXPIRES_AT} serverNow={SERVER_NOW} />);
    expect(secondsShown()).toBe(120);
    expect(screen.getByText('02:00 left')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(secondsShown()).toBe(110);
  });

  it('a wrong device clock does not change the countdown', () => {
    vi.setSystemTime(new Date('2099-01-01T00:00:00Z'));
    render(<OfferCountdown expiresAt={EXPIRES_AT} serverNow={SERVER_NOW} />);
    expect(secondsShown()).toBe(120);
  });

  it('calls onElapsed exactly once when it reaches 0 — it asks for a refetch, it never decides expiry', () => {
    const onElapsed = vi.fn();
    render(<OfferCountdown expiresAt={EXPIRES_AT} serverNow="2026-09-14T10:01:58.000Z" onElapsed={onElapsed} />);
    expect(onElapsed).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(secondsShown()).toBe(0);
    expect(onElapsed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status')).toHaveTextContent('checking the latest status');
  });

  it('restarts from a new server snapshot after a refetch', () => {
    const { rerender } = render(<OfferCountdown expiresAt={EXPIRES_AT} serverNow={SERVER_NOW} />);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(secondsShown()).toBe(90);
    rerender(<OfferCountdown expiresAt={EXPIRES_AT} serverNow="2026-09-14T10:01:00.000Z" />);
    expect(secondsShown()).toBe(60);
  });

  it('hides the per-second value from assistive tech (no per-second announcements)', () => {
    render(<OfferCountdown expiresAt={EXPIRES_AT} serverNow={SERVER_NOW} />);
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});
