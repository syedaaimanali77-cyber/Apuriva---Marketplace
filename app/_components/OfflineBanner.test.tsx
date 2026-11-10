// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/dictionaries/en';
import { setOnline } from './network-test-support';
import { OfflineBanner } from './OfflineBanner';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

/** Spec 044 §3.3/§3.4 (AC-2, AC-3). */
describe('OfflineBanner', () => {
  beforeEach(() => {
    refresh.mockReset();
  });
  afterEach(() => {
    setOnline(true);
  });

  it('shows nothing while online', () => {
    setOnline(true);
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the NETWORK_ERROR notice as a status (not an error alert) when the browser goes offline', () => {
    setOnline(true);
    render(<OfflineBanner />);
    setOnline(false);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(en.errors.NETWORK_ERROR);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('is shown on first render when the page loads offline', () => {
    setOnline(false);
    render(<OfflineBanner />);
    expect(screen.getByRole('status')).toHaveTextContent(en.errors.NETWORK_ERROR);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('clears on reconnect and refreshes the route once per reconnect — never while merely online', () => {
    setOnline(true);
    render(<OfflineBanner />);
    expect(refresh).not.toHaveBeenCalled();

    setOnline(false);
    expect(refresh).not.toHaveBeenCalled();
    setOnline(true);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);

    setOnline(true); // a repeated online event is not a reconnect
    expect(refresh).toHaveBeenCalledTimes(1);

    setOnline(false);
    setOnline(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
