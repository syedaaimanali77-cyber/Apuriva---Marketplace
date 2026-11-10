// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminAiUsagePage from './page';
import type { AiTask, AiUsageSummaryDto, AiUsageTotals } from '@/lib/types/ai';

/** `byTask` is total over the closed AiTask union (spec 033 §3.11), so an empty period still
 *  carries every key as an honest zero rather than omitting it. */
const EMPTY_BY_TASK: Record<AiTask, AiUsageTotals> = {
  search_intent: { requests: 0, tokens: 0 },
  faq_draft: { requests: 0, tokens: 0 },
  conversation: { requests: 0, tokens: 0 },
  summarization: { requests: 0, tokens: 0 },
  translation: { requests: 0, tokens: 0 },
};

const SUMMARY: AiUsageSummaryDto = {
  from: '2026-08-19T00:00:00.000Z',
  to: '2026-09-18T00:00:00.000Z',
  totalRequests: 1_250,
  succeededRequests: 1_190,
  rejectedRequests: 40,
  failedRequests: 20,
  cachedRequests: 500,
  totalTokens: 320_000,
  estimatedCostMinorUnits: 128_000,
  currencyCode: 'PKR',
  byTask: {
    search_intent: { requests: 900, tokens: 180_000 },
    conversation: { requests: 350, tokens: 140_000 },
    faq_draft: { requests: 0, tokens: 0 },
    summarization: { requests: 0, tokens: 0 },
    translation: { requests: 0, tokens: 0 },
  },
  byProvider: { sandbox: { requests: 1_100, tokens: 300_000 }, 'other-vendor': { requests: 150, tokens: 20_000 } },
  costAlertThresholds: { dailyMinorUnits: 500_000, monthlyMinorUnits: 10_000_000, dailyTokens: 500_000 },
};

function stubFetch(response: { ok: boolean; status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: response.ok, status: response.status, json: async () => response.body }),
  );
}

/** Spec 033 §5 — the five documented states of the admin AI usage screen. */
describe('AdminAiUsagePage (spec 033 §5/AC-6)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the success state: stat row plus per-task and per-provider tables', async () => {
    stubFetch({ ok: true, status: 200, body: { data: SUMMARY } });
    render(<AdminAiUsagePage />);

    const stats = within(await screen.findByRole('region', { name: /Last 30 days/i }));
    expect(stats.getByText('1,250')).toBeInTheDocument();
    expect(stats.getByText('320,000')).toBeInTheDocument();
    expect(stats.getByText('PKR 1,280.00')).toBeInTheDocument();
    // 500 of 1,250 cached.
    expect(stats.getByText('40%')).toBeInTheDocument();

    const tables = screen.getAllByRole('table');
    expect(tables).toHaveLength(2);
    expect(within(tables[0]!).getByText('search_intent')).toBeInTheDocument();
    expect(within(tables[0]!).getByText('conversation')).toBeInTheDocument();
    expect(within(tables[1]!).getByText('sandbox')).toBeInTheDocument();

    for (const table of tables) {
      for (const cell of table.querySelectorAll('td')) {
        expect(cell).not.toHaveTextContent('undefined');
        expect(cell).not.toHaveTextContent('NaN');
      }
    }
  });

  it('never renders a user identifier, prompt or response — the payload has none to render', async () => {
    stubFetch({ ok: true, status: 200, body: { data: SUMMARY } });
    render(<AdminAiUsagePage />);
    await screen.findByRole('region', { name: /Last 30 days/i });
    const rendered = document.body.textContent ?? '';
    // No identifier-shaped VALUE can appear, because the payload carries none: no UUID (a user id)
    // and no 64-hex digest (a guest hash or an input fingerprint).
    expect(rendered).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(rendered).not.toMatch(/[0-9a-f]{32,}/i);
    expect(rendered).not.toMatch(/userId|subjectHash|inputFingerprint/);
    // The screen says so plainly too, so an admin knows what they are and are not looking at.
    expect(screen.getByText(/no user identifiers and no prompt or response content/i)).toBeInTheDocument();
  });

  it('renders the loading state before the request resolves', () => {
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
    const { container } = render(<AdminAiUsagePage />);
    expect(screen.getByRole('heading', { name: /AI usage & cost/i })).toBeInTheDocument();
    expect(container.querySelectorAll('[aria-hidden="true"], [data-skeleton]').length).toBeGreaterThan(0);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('renders an honest empty state when the period holds no usage, not a fabricated zero table', async () => {
    stubFetch({
      ok: true,
      status: 200,
      body: {
        data: {
          ...SUMMARY,
          totalRequests: 0,
          totalTokens: 0,
          estimatedCostMinorUnits: 0,
          byTask: EMPTY_BY_TASK,
          byProvider: {},
        },
      },
    });
    render(<AdminAiUsagePage />);

    expect(await screen.findByText(/No AI usage recorded in this period/i)).toBeInTheDocument();
    expect(screen.getByText(/ever seeded or estimated/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('renders the forbidden state for an admin without ai/read_usage, naming the permitted roles', async () => {
    stubFetch({ ok: false, status: 403, body: { code: 'FORBIDDEN', message: 'You do not have permission to view AI usage.' } });
    render(<AdminAiUsagePage />);

    expect(await screen.findByText(/Additional permission required/i)).toBeInTheDocument();
    expect(screen.getByText(/Analytics, Finance and Super Admin roles/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('renders the error state with the server message and retries on demand', async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ code: 'INTERNAL_ERROR', message: 'Usage is unavailable.' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: SUMMARY }) });
    vi.stubGlobal('fetch', fetchMock);

    render(<AdminAiUsagePage />);
    expect(await screen.findByText('Usage is unavailable.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByRole('region', { name: /Last 30 days/i })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('explains a zero cost figure rather than presenting it as a real spend of zero', async () => {
    stubFetch({ ok: true, status: 200, body: { data: { ...SUMMARY, estimatedCostMinorUnits: 0 } } });
    render(<AdminAiUsagePage />);
    expect(await screen.findByText(/No provider rate configured yet/i)).toBeInTheDocument();
  });
});
