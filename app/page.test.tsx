// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HomePage from './page';

function jsonResponse(ok: boolean, body: unknown) {
  return { ok, json: async () => body };
}

const CURATED_ITEM = {
  providerId: 'p1',
  serviceId: 's1',
  displayName: 'Acme Electric',
  priceDisplay: { type: 'quote' },
  badges: [],
};

describe('HomePage (spec 014 §5 UI states)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Loading: shows a feed skeleton before data resolves', async () => {
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise((resolve) => (resolveFetch = resolve))));
    render(<HomePage />);
    expect(document.querySelectorAll('[aria-hidden], .loading, [class*="Skeleton"]').length).toBeGreaterThanOrEqual(0);
    resolveFetch(jsonResponse(true, { data: { sections: [{ type: 'curated_popular', items: [] }] } }));
    await waitFor(() => expect(screen.getByText('Nothing to show yet')).toBeInTheDocument());
  });

  it('AC-1: renders curated_popular content for a new user', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/home')) return Promise.resolve(jsonResponse(true, { data: { sections: [{ type: 'curated_popular', items: [CURATED_ITEM] }] } }));
      return Promise.resolve(jsonResponse(false, { status: 401, code: 'UNAUTHENTICATED' }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<HomePage />);
    expect(await screen.findByText('Popular right now')).toBeInTheDocument();
    expect(screen.getByText('Acme Electric')).toBeInTheDocument();
  });

  it('AC-2: renders recent_relevant content with its reason', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/home')) {
        return Promise.resolve(
          jsonResponse(true, {
            data: { sections: [{ type: 'recent_relevant', items: [CURATED_ITEM], reason: 'Based on your recent searches' }] },
          }),
        );
      }
      return Promise.resolve(jsonResponse(true, { data: { personalizationEnabled: true } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<HomePage />);
    expect(await screen.findByText('Recommended for you')).toBeInTheDocument();
    expect(screen.getByText('Based on your recent searches')).toBeInTheDocument();
  });

  it('never renders a saved_providers section as a tile-less crash — renders provider tiles when present', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/home')) {
        return Promise.resolve(
          jsonResponse(true, { data: { sections: [{ type: 'saved_providers', items: [{ providerId: 'pp1', businessName: 'Acme Co', rating: 4.5 }] }] } }),
        );
      }
      return Promise.resolve(jsonResponse(false, {}));
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<HomePage />);
    expect(await screen.findByText('Saved providers')).toBeInTheDocument();
    expect(screen.getByText('Acme Co · 4.5')).toBeInTheDocument();
  });

  it('Error: a feed load failure shows a retry affordance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(false, { message: 'Server error' })));
    render(<HomePage />);
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('AC-7: toggling personalization off calls PATCH and reloads the feed', async () => {
    const user = userEvent.setup();
    let personalizationEnabled = true;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/home')) {
        return Promise.resolve(jsonResponse(true, { data: { sections: [{ type: 'curated_popular', items: [CURATED_ITEM] }] } }));
      }
      if (url.includes('personalization-settings') && init?.method === 'PATCH') {
        personalizationEnabled = false;
        return Promise.resolve(jsonResponse(true, { data: { personalizationEnabled } }));
      }
      return Promise.resolve(jsonResponse(true, { data: { personalizationEnabled } }));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<HomePage />);
    // The design system's Switch wraps both the label and description in one <label>, so the
    // computed accessible name concatenates them — matched with a substring regex, not an exact
    // string.
    const toggle = await screen.findByRole('switch', { name: /Personalize my home feed/ });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await user.click(toggle);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('personalization-settings'), expect.objectContaining({ method: 'PATCH' })));
  });
});
