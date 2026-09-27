// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureFlagDto } from '@/lib/types/feature-flags';
import AdminFeatureFlagsPage from './page';

function flag(overrides: Partial<FeatureFlagDto>): FeatureFlagDto {
  return {
    key: 'onboarding-intro-v1',
    description: 'Shows the first-run introduction.',
    controlledBy: 'business',
    isKillSwitch: false,
    clientReadable: true,
    removalCriteria: null,
    environment: 'staging',
    enabled: true,
    effective: true,
    overriddenBy: null,
    version: 3,
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const BUSINESS = flag({});
const PINNED = flag({ key: 'search-nl-interpretation', description: 'NL search.', clientReadable: false, overriddenBy: 'SEARCH_NL_INTERPRETATION_ENABLED' });
const KILL = flag({ key: 'ai-assistant', description: 'Platform AI kill switch.', controlledBy: 'developer', isKillSwitch: true, clientReadable: false });

type Reply = { status: number; body: unknown };

function stubFetch(list: Reply | (() => Reply), patch?: Reply | ((body: unknown) => Reply)) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const isPatch = init?.method === 'PATCH';
    const entry = isPatch ? patch : list;
    const reply = typeof entry === 'function' ? (entry as (b: unknown) => Reply)(init?.body ? JSON.parse(String(init.body)) : undefined) : entry;
    if (!reply) throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const ok = (data: unknown): Reply => ({ status: 200, body: { data } });

/** Spec 041 §5 — the feature-flag admin page. */
describe('AdminFeatureFlagsPage (spec 041 §5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loading: a skeleton before the list arrives', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    render(<AdminFeatureFlagsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Feature flags' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('success: environment, rows, badges, override note (pinned switch disabled)', async () => {
    stubFetch(ok([BUSINESS, PINNED, KILL]));
    render(<AdminFeatureFlagsPage />);
    const table = await screen.findByRole('table');
    expect(screen.getByText('Staging')).toBeInTheDocument();
    expect(within(table).getByText('onboarding-intro-v1')).toBeInTheDocument();
    expect(within(table).getByText('Technical')).toBeInTheDocument();
    expect(within(table).getByText('Kill switch')).toBeInTheDocument();
    expect(within(table).getByText('SEARCH_NL_INTERPRETATION_ENABLED')).toBeInTheDocument();
    const switches = within(table).getAllByRole('switch');
    expect(switches).toHaveLength(3);
    expect(switches[1]).toBeDisabled();
    expect(switches[0]).toBeEnabled();
  });

  it('a business admin never sees technical rows (they are absent from the response)', async () => {
    stubFetch(ok([BUSINESS]));
    render(<AdminFeatureFlagsPage />);
    const table = await screen.findByRole('table');
    expect(within(table).queryByText('Technical')).toBeNull();
    expect(within(table).queryByText('ai-assistant')).toBeNull();
  });

  it('forbidden: a 403 list shows the no-access state', async () => {
    stubFetch({ status: 403, body: { code: 'FORBIDDEN', message: 'no' } });
    render(<AdminFeatureFlagsPage />);
    expect(await screen.findByText("You don't have access to feature flags.")).toBeInTheDocument();
  });

  it('error: retry refetches the list', async () => {
    let calls = 0;
    const fetchMock = stubFetch(() => {
      calls += 1;
      return calls === 1 ? { status: 500, body: { code: 'INTERNAL_ERROR', message: 'Boom.' } } : ok([BUSINESS]);
    });
    render(<AdminFeatureFlagsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /retry|try again/i }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('toggle: reason panel → confirm dialog → PATCH with environment, version and reason; the row updates from the server', async () => {
    const fetchMock = stubFetch(ok([BUSINESS]), (body) => ok({ ...BUSINESS, enabled: (body as { enabled: boolean }).enabled, version: 4 }));
    render(<AdminFeatureFlagsPage />);
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('switch'));

    const panel = screen.getByRole('region', { name: 'Turn onboarding-intro-v1 off' });
    // No reason: the dialog does not open.
    await userEvent.click(within(panel).getByRole('button', { name: 'Review change' }));
    expect(screen.getByText('A reason is required (up to 500 characters).')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await userEvent.type(within(panel).getByRole('textbox'), 'Intro underperforms');
    await userEvent.click(within(panel).getByRole('button', { name: 'Review change' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Staging only\. Reason: Intro underperforms/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn off' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('/api/v1/admin/feature-flags/onboarding-intro-v1');
    expect(JSON.parse(String(init!.body))).toEqual({ environment: 'staging', enabled: false, expectedVersion: 3, reason: 'Intro underperforms' });
    expect((init!.headers as Record<string, string>)['x-csrf-token']).toBeDefined();
    await waitFor(() => expect(within(screen.getByRole('table')).getByRole('switch')).not.toBeChecked());
    expect(screen.queryByRole('region', { name: /Turn onboarding-intro-v1/ })).toBeNull();
  });

  it('production: the panel warns, and the dialog says so', async () => {
    const prod = flag({ environment: 'production' });
    stubFetch(ok([prod]), ok({ ...prod, enabled: false }));
    render(<AdminFeatureFlagsPage />);
    await userEvent.click(within(await screen.findByRole('table')).getByRole('switch'));
    expect(screen.getByText('Production change')).toBeInTheDocument();
    const panel = screen.getByRole('region', { name: /Turn onboarding-intro-v1/ });
    await userEvent.type(within(panel).getByRole('textbox'), 'Emergency');
    await userEvent.click(within(panel).getByRole('button', { name: 'Review change' }));
    expect(within(await screen.findByRole('alertdialog')).getByText(/live production platform/)).toBeInTheDocument();
  });

  it('failure: the switch keeps its prior state and the reason is shown; a conflict refetches', async () => {
    const fetchMock = stubFetch(ok([BUSINESS]), { status: 409, body: { code: 'CONFLICT', message: 'changed' } });
    render(<AdminFeatureFlagsPage />);
    await userEvent.click(within(await screen.findByRole('table')).getByRole('switch'));
    const panel = screen.getByRole('region', { name: /Turn onboarding-intro-v1/ });
    await userEvent.type(within(panel).getByRole('textbox'), 'x');
    await userEvent.click(within(panel).getByRole('button', { name: 'Review change' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText(/Someone else changed this flag/)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(within(await screen.findByRole('table')).getByRole('switch')).toBeChecked();
  });

  it('failure: forbidden and environment-mismatch messages; cancel closes the panel', async () => {
    let reply: Reply = { status: 403, body: { code: 'FORBIDDEN' } };
    stubFetch(ok([BUSINESS]), () => reply);
    render(<AdminFeatureFlagsPage />);
    const attempt = async () => {
      await userEvent.click(within(await screen.findByRole('table')).getByRole('switch'));
      const panel = screen.getByRole('region', { name: /Turn onboarding-intro-v1/ });
      await userEvent.type(within(panel).getByRole('textbox'), 'r');
      await userEvent.click(within(panel).getByRole('button', { name: 'Review change' }));
      await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Turn off' }));
    };
    await attempt();
    expect(await screen.findByText("You don't have permission to change this flag.")).toBeInTheDocument();
    reply = { status: 409, body: { code: 'FLAG_ENVIRONMENT_MISMATCH' } };
    await attempt();
    expect(await screen.findByText(/different environment/)).toBeInTheDocument();

    await userEvent.click(within(screen.getByRole('table')).getByRole('switch'));
    await userEvent.click(within(screen.getByRole('region', { name: /Turn onboarding-intro-v1/ })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('region', { name: /Turn onboarding-intro-v1/ })).toBeNull();
  });
});
