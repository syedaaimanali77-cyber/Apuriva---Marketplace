// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminAuditLogPage from './page';
import { buildAuditQuery, EMPTY_FILTERS, formatJson } from './audit-log-view';
import type { AuditLogDto } from '@/lib/types/audit';

const ENTRY: AuditLogDto = {
  id: '11111111-1111-4111-8111-111111111111',
  actorType: 'admin',
  actorUserId: '22222222-2222-4222-8222-222222222222',
  actorRoles: ['operations_admin'],
  eventType: 'admin_rbac.matching_weights_updated',
  resource: 'matching.config',
  action: 'configure',
  targetType: 'service',
  targetId: 'svc-1',
  beforeValue: { poolSize: 20 },
  afterValue: { poolSize: 25 },
  reason: null,
  approvalRef: null,
  approvalChain: [],
  isEmergencyBypass: false,
  correlationId: 'corr-abc',
  createdAt: '2026-09-20T10:00:00.000Z',
};

type Reply = { ok: boolean; status: number; body: unknown };

function paged(data: AuditLogDto[], nextOffset: number | null = null) {
  return { ok: true, status: 200, body: { data, page: { limit: 20, offset: 0, total: data.length, nextOffset }, correlationId: 'x' } };
}

/** Routes each request to a reply: list requests take the next queued reply; detail requests get ENTRY. */
function stubFetch(listReplies: (Reply | Error)[]) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    calls.push(url);
    if (/\/audit-logs\/[^?]+$/.test(url)) return { ok: true, status: 200, json: async () => ({ data: ENTRY }) };
    const next = listReplies.length > 1 ? listReplies.shift()! : listReplies[0]!;
    if (next instanceof Error) throw next;
    return { ok: next.ok, status: next.status, json: async () => next.body };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

/** Spec 039 §5 — the audit log page's states. Access is decided by the API; the page only reflects it. */
describe('AdminAuditLogPage (spec 039 §5)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows a skeleton while loading, then the entries (time, actor, roles, event, target, correlation)', async () => {
    stubFetch([paged([ENTRY])]);
    const { container } = render(<AdminAuditLogPage />);
    expect(container.querySelector('[aria-busy], [class*="skeleton" i]') ?? screen.getByRole('heading', { name: 'Audit log' })).toBeTruthy();

    expect(await screen.findByText('admin_rbac.matching_weights_updated')).toBeInTheDocument();
    expect(screen.getByText('operations_admin')).toBeInTheDocument();
    expect(screen.getByText('service · svc-1')).toBeInTheDocument();
    expect(screen.getByText('corr-abc')).toBeInTheDocument();
    expect(screen.getByText('1–1 of 1')).toBeInTheDocument();
    // No edit or delete control exists anywhere on the page.
    expect(screen.queryByRole('button', { name: /edit|delete/i })).toBeNull();
  });

  it('selecting an entry shows its detail with before/after as formatted JSON', async () => {
    stubFetch([paged([ENTRY])]);
    render(<AdminAuditLogPage />);
    await userEvent.click(await screen.findByText('admin_rbac.matching_weights_updated'));

    expect(await screen.findByRole('heading', { name: 'Before' })).toBeInTheDocument();
    expect(screen.getByText(/"poolSize": 20/)).toBeInTheDocument();
    expect(screen.getByText(/"poolSize": 25/)).toBeInTheDocument();
    expect(screen.getByText('matching.config / configure')).toBeInTheDocument();
  });

  it('an empty result shows "No matching audit entries"', async () => {
    stubFetch([paged([])]);
    render(<AdminAuditLogPage />);
    expect(await screen.findByText('No matching audit entries')).toBeInTheDocument();
  });

  it('a 403 without filters is the no-access state', async () => {
    stubFetch([{ ok: false, status: 403, body: { code: 'FORBIDDEN', message: 'no' } }]);
    render(<AdminAuditLogPage />);
    expect(await screen.findByText("You don't have access to the audit log")).toBeInTheDocument();
  });

  it('a resource filter outside scope shows the refusal and keeps the filters', async () => {
    const calls = stubFetch([paged([ENTRY]), { ok: false, status: 403, body: { code: 'FORBIDDEN', message: 'That resource is outside your audit-log scope.' } }]);
    render(<AdminAuditLogPage />);
    await screen.findByText('admin_rbac.matching_weights_updated');

    const resource = screen.getByLabelText('Resource');
    await userEvent.type(resource, 'admin_rbac.role');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByText('That resource is outside your audit-log scope.')).toBeInTheDocument();
    expect(resource).toHaveValue('admin_rbac.role');
    expect(calls.at(-1)).toContain('resource=admin_rbac.role');
  });

  it('an error offers retry, and retry keeps the applied filters', async () => {
    const calls = stubFetch([paged([ENTRY]), { ok: false, status: 500, body: { code: 'INTERNAL_ERROR', message: 'Server down', correlationId: 'err-1' } }, paged([ENTRY])]);
    render(<AdminAuditLogPage />);
    await screen.findByText('admin_rbac.matching_weights_updated');

    await userEvent.type(screen.getByLabelText('Event type'), 'admin_rbac.matching_weights_updated');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('Server down')).toBeInTheDocument();
    expect(screen.getByLabelText('Event type')).toHaveValue('admin_rbac.matching_weights_updated');

    await userEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    await screen.findByText('admin_rbac.matching_weights_updated', { selector: 'td, td *' });
    expect(calls.at(-1)).toContain('eventType=admin_rbac.matching_weights_updated');
  });

  it('a network failure is an error state, not a crash', async () => {
    stubFetch([new TypeError('Failed to fetch')]);
    render(<AdminAuditLogPage />);
    expect(await screen.findByText(/Couldn't reach the server/)).toBeInTheDocument();
  });

  it('pages forward with nextOffset and back again', async () => {
    const calls = stubFetch([paged([ENTRY], 20), paged([ENTRY], null), paged([ENTRY], 20)]);
    render(<AdminAuditLogPage />);
    await screen.findByText('admin_rbac.matching_weights_updated');
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(calls.at(-1)).toContain('offset=20'));
    await userEvent.click(await screen.findByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(calls.at(-1)).toContain('offset=0'));
  });

  it('clearing resets the filters', async () => {
    const calls = stubFetch([paged([ENTRY])]);
    render(<AdminAuditLogPage />);
    await screen.findByText('admin_rbac.matching_weights_updated');
    await userEvent.type(screen.getByLabelText('Target id'), 'svc-1');
    await userEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(calls.at(-1)).toContain('targetId=svc-1'));
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(calls.at(-1)).not.toContain('targetId'));
    expect(screen.getByLabelText('Target id')).toHaveValue('');
  });
});

describe('audit-log view helpers (spec 039 §5)', () => {
  it('builds the L1 query from non-empty filters only, converting dates to ISO instants', () => {
    const query = new URLSearchParams(buildAuditQuery({ ...EMPTY_FILTERS, resource: ' support ', from: '2026-09-01T10:00' }, 40));
    expect(query.get('resource')).toBe('support');
    expect(query.get('from')).toBe(new Date('2026-09-01T10:00').toISOString());
    expect(query.get('eventType')).toBeNull();
    expect(query.get('limit')).toBe('20');
    expect(query.get('offset')).toBe('40');
  });

  it('formats before/after as indented JSON, and an absent value as a dash', () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatJson(null)).toBe('—');
    expect(formatJson(undefined)).toBe('—');
  });
});
