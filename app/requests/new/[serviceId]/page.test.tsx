// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import NewRequestPage from './page';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ serviceId: 'service-1' }),
  useRouter: () => ({ push }),
}));

const SERVICE = { id: 'service-1', name: 'Plumbing' };
const FIELDS = [
  { id: 'f1', serviceId: 'service-1', key: 'problem', label: 'What is the problem', type: 'text', required: true, sortOrder: 0 },
];
const ADDRESSES = [{ id: 'addr-1', label: 'Home', isDefault: true, structured: {}, approxAreaLabel: 'Gulberg' }];

function jsonResponse(ok: boolean, body: unknown, status = ok ? 200 : 400) {
  return { ok, status, json: async () => body };
}

/** Routes every load request; `onCreate` answers the POST. */
function stubFetch(onCreate: () => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(onCreate());
      if (url.includes('/fields')) return Promise.resolve(jsonResponse(true, { data: FIELDS }));
      if (url.includes('/addresses')) return Promise.resolve(jsonResponse(true, { data: ADDRESSES }));
      return Promise.resolve(jsonResponse(true, { data: SERVICE }));
    }),
  );
}

describe('NewRequestPage (spec 015 §5 UI states)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    push.mockReset();
  });

  it('renders the service-specific fields from spec 011, never a hardcoded list', async () => {
    stubFetch(() => jsonResponse(true, { data: { id: 'r1' } }, 201));
    render(<NewRequestPage />);

    expect(await screen.findByLabelText(/What is the problem/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Request plumbing/i })).toBeInTheDocument();
  });

  it('AC-3: budget starts at "I\'m not sure" — no amount input is required to submit', async () => {
    stubFetch(() => jsonResponse(true, { data: { id: 'r1' } }, 201));
    render(<NewRequestPage />);

    await screen.findByLabelText(/What is the problem/i);
    expect(screen.getByRole('radio', { name: /I'm not sure/i })).toBeChecked();
    // The currency-suffixed label belongs to the amount input, not the identically-named radio.
    expect(screen.queryByLabelText(/Target amount \(PKR\)/i)).not.toBeInTheDocument();
  });

  it('AC-3: choosing "Target amount" reveals the amount input', async () => {
    stubFetch(() => jsonResponse(true, { data: { id: 'r1' } }, 201));
    render(<NewRequestPage />);

    await screen.findByLabelText(/What is the problem/i);
    await userEvent.click(screen.getByRole('radio', { name: /Target amount/i }));

    expect(await screen.findByLabelText(/Target amount \(PKR\)/i)).toBeInTheDocument();
  });

  it('§5 Error: a field error is shown against its own control and entered values are preserved', async () => {
    stubFetch(() =>
      jsonResponse(false, { code: 'VALIDATION_ERROR', message: 'The request failed validation.', errors: [{ field: 'problem', message: 'What is the problem is required' }] }),
    );
    render(<NewRequestPage />);

    const description = await screen.findByLabelText(/Describe the job/i);
    await userEvent.type(description, 'Tap is dripping');
    await userEvent.click(screen.getByRole('button', { name: /Send request/i }));

    expect(await screen.findByText('What is the problem is required')).toBeInTheDocument();
    expect(description).toHaveValue('Tap is dripping');
    expect(push).not.toHaveBeenCalled();
  });

  it('§3: sends the Idempotency-Key header, and the same one on a retry after failure', async () => {
    const responses = [
      jsonResponse(false, { code: 'INTERNAL_ERROR', message: 'boom' }, 500),
      jsonResponse(true, { data: { id: 'r1' } }, 201),
    ];
    stubFetch(() => responses.shift()!);
    render(<NewRequestPage />);

    await screen.findByLabelText(/What is the problem/i);
    const submit = screen.getByRole('button', { name: /Send request/i });

    await userEvent.click(submit);
    await screen.findByText('boom');
    await userEvent.click(submit);

    await waitFor(() => expect(push).toHaveBeenCalledWith('/requests/r1'));

    const posts = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.filter(
      ([, init]) => init?.method === 'POST',
    );
    expect(posts).toHaveLength(2);
    const keys = posts.map(([, init]) => (init!.headers as Record<string, string>)['Idempotency-Key']);
    expect(keys[0]).toBeTruthy();
    // The retry must reuse the key — that is what makes the second attempt resolve to one request.
    expect(keys[1]).toBe(keys[0]);
  });

  it('§5 Success: a created request navigates straight to its status view', async () => {
    stubFetch(() => jsonResponse(true, { data: { id: 'r-42' } }, 201));
    render(<NewRequestPage />);

    await screen.findByLabelText(/What is the problem/i);
    await userEvent.click(screen.getByRole('button', { name: /Send request/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith('/requests/r-42'));
  });
});
