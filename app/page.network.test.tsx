// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomePage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

/**
 * Home's three loads (feed, personalization settings, categories) go through the shared
 * `apiFetch`, so a request that never completes resolves as NETWORK_ERROR instead of an unhandled
 * `TypeError: Failed to fetch` (which Vitest itself fails the run on).
 */
const ITEM = { providerId: 'p1', serviceId: 's1', displayName: 'Acme Electric', priceDisplay: { type: 'quote' }, badges: [] };
const FEED = { data: { sections: [{ type: 'curated_popular', items: [ITEM] }] } };

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body });
const unauthenticated = () => Promise.resolve({ ok: false, status: 401, json: async () => ({ code: 'UNAUTHENTICATED' }) });
const networkFailure = () => Promise.reject(new TypeError('Failed to fetch'));

describe('HomePage — network failures (Failed to fetch)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('an unreachable feed shows the existing ErrorState, and Try again loads it', async () => {
    let feedCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/api/v1/home')) return (feedCalls += 1) === 1 ? networkFailure() : ok(FEED);
        return unauthenticated();
      }),
    );
    render(<HomePage />);
    expect(await screen.findByText('We could not reach the server.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Acme Electric')).toBeInTheDocument();
  });

  it('unreachable supplementary loads (settings, categories) degrade silently — no error, feed still shown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => (url.endsWith('/api/v1/home') ? ok(FEED) : networkFailure())),
    );
    render(<HomePage />);
    expect(await screen.findByText('Acme Electric')).toBeInTheDocument();
    expect(screen.queryByText('We could not reach the server.')).not.toBeInTheDocument();
  });

  it('a real HTTP error on the feed keeps its own message — not disguised as a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.endsWith('/api/v1/home')
          ? Promise.resolve({ ok: false, status: 500, json: async () => ({ code: 'INTERNAL_ERROR', message: 'Feed exploded' }) })
          : unauthenticated(),
      ),
    );
    render(<HomePage />);
    expect(await screen.findByText('Feed exploded')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('We could not reach the server.')).not.toBeInTheDocument());
  });
});
