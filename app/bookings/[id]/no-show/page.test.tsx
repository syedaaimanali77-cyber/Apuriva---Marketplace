// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import type { NoShowReportDto } from '@/lib/types/no-show';
import NoShowPage from './page';

vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'booking-1' }) }));

const apiFetch = vi.fn();
vi.mock('../../booking-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  mutateHeaders: () => ({ 'content-type': 'application/json' }),
}));

function report(overrides: Partial<NoShowReportDto> = {}): NoShowReportDto {
  return {
    id: 'report-1',
    bookingId: 'booking-1',
    reporterRole: 'customer',
    isOwnReport: true,
    status: 'awaiting_response',
    respondByAt: '2026-01-02T00:00:00.000Z',
    responseFiled: false,
    responseFiledAt: null,
    outcome: null,
    resolvedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

function givenReports(rows: NoShowReportDto[]): void {
  apiFetch.mockResolvedValue({ ok: true, data: rows });
}

/**
 * Spec 023 §5 — the neutral-language requirement (master spec §51), asserted as UI behaviour.
 *
 * The backend refusing to decide is only half the promise. If the screen said "the provider did not
 * attend" while a report was merely open, the platform would be accusing someone regardless of what
 * the database thought — so the copy is tested, not just the state machine.
 */
describe('no-show screen (spec 023 AC-5)', () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('describes an open report as waiting for a response, never as a finding', async () => {
    givenReports([report()]);
    render(<NoShowPage />);

    expect(await screen.findByText('Waiting for a response')).toBeInTheDocument();
    expect(screen.getByText(/Nothing is decided until they do/i)).toBeInTheDocument();
    expect(screen.queryByText(/did not attend\./i)).not.toBeInTheDocument();
  });

  it('describes review neutrally and states that nothing has been charged', async () => {
    givenReports([report({ status: 'under_review', responseFiled: true })]);
    render(<NoShowPage />);

    expect(await screen.findByText('Under review')).toBeInTheDocument();
    expect(screen.getByText(/No conclusion has been reached and no charge has been applied/i)).toBeInTheDocument();
  });

  /** The wording must not change with who reported — that asymmetry would itself be an accusation. */
  it('uses the same review wording whichever party reported', async () => {
    givenReports([report({ status: 'under_review', isOwnReport: false, reporterRole: 'provider' })]);
    render(<NoShowPage />);

    expect(await screen.findByText('Under review')).toBeInTheDocument();
    expect(screen.getByText(/No conclusion has been reached and no charge has been applied/i)).toBeInTheDocument();
  });

  it('states an outcome only once a human has resolved it', async () => {
    givenReports([report({ status: 'resolved', outcome: 'no_show_confirmed_provider', resolvedAt: '2026-01-03T00:00:00Z' })]);
    render(<NoShowPage />);

    expect(await screen.findByText('Resolved')).toBeInTheDocument();
    expect(screen.getByText(/Reviewed: the provider did not attend\./i)).toBeInTheDocument();
  });

  it('offers a response form to the other party, framed as their account of events', async () => {
    givenReports([report({ isOwnReport: false, reporterRole: 'provider' })]);
    render(<NoShowPage />);

    expect(await screen.findByRole('button', { name: /send response/i })).toBeInTheDocument();
    expect(screen.getByText(/goes to our review team, not to the other party/i)).toBeInTheDocument();
  });

  it('tells a reporter that reporting alone charges nobody', async () => {
    givenReports([]);
    render(<NoShowPage />);

    await waitFor(() => expect(screen.getByRole('button', { name: /submit report/i })).toBeInTheDocument());
    expect(screen.getByText(/does not by itself\s+charge anyone or cancel the booking/i)).toBeInTheDocument();
  });

  it('lets a reporter withdraw while the other party has not yet responded', async () => {
    givenReports([report()]);
    render(<NoShowPage />);

    expect(await screen.findByRole('button', { name: /withdraw report/i })).toBeInTheDocument();
  });

  it('offers no withdrawal once the report is under review', async () => {
    givenReports([report({ status: 'under_review' })]);
    render(<NoShowPage />);

    await screen.findByText('Under review');
    expect(screen.queryByRole('button', { name: /withdraw report/i })).not.toBeInTheDocument();
  });
});
