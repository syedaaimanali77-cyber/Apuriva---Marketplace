// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SearchPage from './page';
import { en } from '@/lib/i18n/dictionaries/en';

const push = vi.fn();
const urlState = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(urlState.search),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

class FakeIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

interface MockResponse {
  ok: boolean;
  status?: number;
  data?: unknown;
  page?: { limit: number; offset: number; total: number; nextOffset: number | null };
  error?: { code: string; message: string };
}

function jsonResponse(body: MockResponse) {
  return {
    ok: body.ok,
    status: body.status ?? (body.ok ? 200 : 400),
    json: async () =>
      body.ok
        ? { data: body.data, page: body.page, correlationId: 'x' }
        : { status: body.status ?? 400, code: body.error!.code, message: body.error!.message, correlationId: 'x' },
  };
}

const RESULT_A = {
  providerId: 'p1',
  serviceId: 's1',
  displayName: 'Acme Electric',
  priceDisplay: { type: 'exact', amountMinorUnits: 500000, currencyCode: 'PKR' },
  badges: [],
};

type Handler = (url: string, init?: RequestInit) => MockResponse | undefined;

function installFetchMock(handlers: Handler[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      for (const handler of handlers) {
        const result = handler(url, init);
        if (result) return jsonResponse(result) as Response;
      }
      throw new Error(`Unhandled fetch: ${init?.method ?? 'GET'} ${url}`);
    }),
  );
}

function searchHandler(data: unknown[], total = data.length): Handler {
  return (url, init) =>
    url.includes('/api/v1/search?') && (!init?.method || init.method === 'GET')
      ? { ok: true, data, page: { limit: 20, offset: 0, total, nextOffset: null } }
      : undefined;
}

function recentHandler(): Handler {
  return (url, init) => (url.endsWith('/api/v1/search/recent') && init?.method === 'POST' ? { ok: true, status: 204 } : undefined);
}

function autocompleteHandler(): Handler {
  return (url, init) => (url.includes('/api/v1/search/autocomplete') && (!init?.method || init.method === 'GET') ? { ok: true, data: [] } : undefined);
}

describe('SearchPage (spec 013 §5 UI states)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockClear();
    urlState.search = '';
  });

  it('AC-3: renders a non-dead-end empty state with actionable next steps, never a permission prompt', async () => {
    installFetchMock([
      (url, init) =>
        url.endsWith('/api/v1/search/interpret') && init?.method === 'POST'
          ? { ok: false, status: 422, error: { code: 'INTERPRETATION_LOW_CONFIDENCE', message: 'low confidence' } }
          : undefined,
      searchHandler([]),
      recentHandler(),
      autocompleteHandler(),
    ]);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByLabelText('Search for a service'), 'electrician');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('No results found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Browse nearby' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Post a request' })).toBeDisabled();
    expect(screen.queryByText(/allow location/i)).not.toBeInTheDocument();
  });

  it('AC-1: shows real results and an AI-interpretation note when intent resolves', async () => {
    installFetchMock([
      (url, init) =>
        url.endsWith('/api/v1/search/interpret') && init?.method === 'POST'
          ? { ok: true, data: { serviceId: 's1', serviceNameRaw: undefined, confidence: 'high' } }
          : undefined,
      searchHandler([RESULT_A]),
      recentHandler(),
      autocompleteHandler(),
    ]);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByLabelText('Search for a service'), 'electrician');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Acme Electric')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/suggested by AI interpretation/i);
  });

  it('AC-1 fallback: a low-confidence interpretation falls back to plain keyword search, no AI note shown', async () => {
    installFetchMock([
      (url, init) =>
        url.endsWith('/api/v1/search/interpret') && init?.method === 'POST'
          ? { ok: false, status: 422, error: { code: 'INTERPRETATION_LOW_CONFIDENCE', message: 'low confidence' } }
          : undefined,
      searchHandler([RESULT_A]),
      recentHandler(),
      autocompleteHandler(),
    ]);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByLabelText('Search for a service'), 'electrician');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Acme Electric')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('error state renders with a retry action and never silently drops the query', async () => {
    installFetchMock([
      (url, init) =>
        url.endsWith('/api/v1/search/interpret') && init?.method === 'POST'
          ? { ok: false, status: 422, error: { code: 'INTERPRETATION_LOW_CONFIDENCE', message: 'low confidence' } }
          : undefined,
      (url, init) =>
        url.includes('/api/v1/search?') && (!init?.method || init.method === 'GET')
          ? { ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }
          : undefined,
      autocompleteHandler(),
    ]);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByLabelText('Search for a service'), 'electrician');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    // Spec 042 §3.7: a known stable code renders its dictionary text, not the server's English message.
    expect(await screen.findByRole('alert')).toHaveTextContent(en.errors.INTERNAL_ERROR);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('AC-4 desktop: pagination controls (Previous/Next) render for results, not infinite scroll', async () => {
    installFetchMock([
      (url, init) =>
        url.endsWith('/api/v1/search/interpret') && init?.method === 'POST'
          ? { ok: false, status: 422, error: { code: 'INTERPRETATION_LOW_CONFIDENCE', message: 'low confidence' } }
          : undefined,
      (url, init) =>
        url.includes('/api/v1/search?') && (!init?.method || init.method === 'GET')
          ? { ok: true, data: [RESULT_A], page: { limit: 20, offset: 0, total: 40, nextOffset: 20 } }
          : undefined,
      recentHandler(),
      autocompleteHandler(),
    ]);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByLabelText('Search for a service'), 'electrician');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await screen.findByText('Acme Electric');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('no voice-input mic button renders when the browser has no SpeechRecognition (never voice-only)', async () => {
    installFetchMock([searchHandler([]), recentHandler(), autocompleteHandler()]);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    render(<SearchPage />);

    expect(screen.getByLabelText('Search for a service')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /search by voice/i })).not.toBeInTheDocument();
  });

  describe('layout stability: a deep-linked query does not open the suggestions card (spec 044 CLS)', () => {
    const SUGGESTION = { type: 'service', label: 'Deep cleaning', value: 'Deep cleaning' };
    const suggestingAutocomplete: Handler = (url, init) =>
      url.includes('/api/v1/search/autocomplete') && (!init?.method || init.method === 'GET') ? { ok: true, data: [SUGGESTION] } : undefined;
    const autocompleteCalls = () => vi.mocked(fetch).mock.calls.filter(([input]) => String(input).includes('/api/v1/search/autocomplete'));

    it('/search?q=cleaning: nothing is inserted above the empty state after it renders', async () => {
      urlState.search = 'q=cleaning';
      installFetchMock([searchHandler([]), recentHandler(), suggestingAutocomplete]);
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
      render(<SearchPage />);

      expect(await screen.findByText('No results found')).toBeInTheDocument();
      expect(screen.getByLabelText('Search for a service')).toHaveValue('cleaning');
      // Past the 200ms autocomplete debounce: the card that used to appear here, above the empty state,
      // is what shifted the layout (0.143 CLS in the spec 044 Lighthouse run).
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(autocompleteCalls()).toHaveLength(0);
      expect(screen.queryByRole('list', { name: en.search.suggestions })).not.toBeInTheDocument();
      expect(screen.getByText('No results found')).toBeInTheDocument();
    });

    it('AC-2 is unchanged: once the user edits the deep-linked query, suggestions follow typing', async () => {
      urlState.search = 'q=cleaning';
      installFetchMock([searchHandler([]), recentHandler(), suggestingAutocomplete]);
      vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
      const user = userEvent.setup();
      render(<SearchPage />);

      await screen.findByText('No results found');
      await user.type(screen.getByLabelText('Search for a service'), ' deep');

      expect(await screen.findByRole('list', { name: en.search.suggestions })).toHaveTextContent('Deep cleaning');
      expect(autocompleteCalls().at(-1)?.[0]).toContain('q=cleaning%20deep');
    });
  });

  it('a removable intent chip re-runs search without that filter', async () => {
    installFetchMock([
      (url, init) =>
        url.endsWith('/api/v1/search/interpret') && init?.method === 'POST'
          ? { ok: true, data: { serviceId: 's1', budgetMaxMinorUnits: 300000, confidence: 'high' } }
          : undefined,
      searchHandler([RESULT_A]),
      recentHandler(),
      autocompleteHandler(),
    ]);
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByLabelText('Search for a service'), 'electrician under 3000');
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await screen.findByText('Acme Electric');
    const chip = screen.getByText(/Budget/);
    expect(chip).toBeInTheDocument();
    await user.click(within(chip).getByRole('button', { name: /remove/i }));

    await waitFor(() => expect(screen.queryByText(/Budget/)).not.toBeInTheDocument());
  });
});
