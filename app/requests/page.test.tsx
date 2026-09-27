// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RequestsPage from './page';
import type { RequestSummaryDto } from '@/lib/types/requests';

const REQUEST: RequestSummaryDto = {
  id: 'req-1',
  status: 'submitted',
  customerFacingStep: 'Request sent',
  serviceId: 'service-1',
  serviceName: 'Plumbing',
  offerCount: 0,
  createdAt: '2026-09-01T10:00:00.000Z',
};

function pagedResponse(data: RequestSummaryDto[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data, page: { limit: 20, offset: 0, total: data.length, nextOffset: null } }),
  };
}

/**
 * Spec 015 §5 — the `/requests` list. These cover the `TypeError: Failed to fetch` crash: the page
 * has always implemented an error state with a Retry, but a network-level fetch rejection bypassed
 * it entirely and took the screen down instead.
 */
describe('RequestsPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows its error state instead of crashing when the request never reaches the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));

    // Rendering must not reject: the regression was an unhandled rejection out of useEffect.
    render(<RequestsPage />);

    await waitFor(() => expect(screen.getByText('We could not reach the server.')).toBeInTheDocument());
    // The skeleton must not be left spinning forever.
    expect(screen.queryByText('Your requests')).toBeInTheDocument();
  });

  it('retries from the error state and recovers once the server is reachable again', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new TypeError('Failed to fetch');
      })
      .mockImplementation(async () => pagedResponse([REQUEST]));
    vi.stubGlobal('fetch', fetchMock);

    render(<RequestsPage />);
    await waitFor(() => expect(screen.getByText('We could not reach the server.')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /try again|retry/i }));

    await waitFor(() => expect(screen.getByText('Plumbing')).toBeInTheDocument());
    expect(screen.queryByText('We could not reach the server.')).not.toBeInTheDocument();
  });

  it('requests its own list from the v1 endpoint with the active filter', async () => {
    const fetchMock = vi.fn(async () => pagedResponse([REQUEST]));
    vi.stubGlobal('fetch', fetchMock);

    render(<RequestsPage />);

    await waitFor(() => expect(screen.getByText('Plumbing')).toBeInTheDocument());
    const [firstCall] = fetchMock.mock.calls;
    const url = String((firstCall as unknown as [string])[0]);
    expect(url).toContain('/api/v1/requests?');
    expect(url).toContain('filter=active');
  });

  it('shows the empty state, not an error, when the caller has no requests', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => pagedResponse([])));

    render(<RequestsPage />);

    await waitFor(() => expect(screen.getByText('No active requests')).toBeInTheDocument());
    expect(screen.queryByText('We could not reach the server.')).not.toBeInTheDocument();
  });
});
