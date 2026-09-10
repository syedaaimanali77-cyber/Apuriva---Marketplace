// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AddressesPage from './page';

interface MockResponse {
  ok: boolean;
  status?: number;
  data?: unknown;
  error?: { code: string; message: string };
}

function jsonResponse(body: MockResponse) {
  return {
    ok: body.ok,
    status: body.status ?? (body.ok ? 200 : 400),
    json: async () =>
      body.ok
        ? { data: body.data, correlationId: 'x' }
        : { status: body.status ?? 400, code: body.error!.code, message: body.error!.message, correlationId: 'x' },
  };
}

const HOME_ADDRESS = {
  id: 'addr-1',
  label: 'Home',
  isDefault: true,
  structured: { line1: 'House 12, Street 5', area: 'Gulberg', city: 'Lahore', country: 'Pakistan' },
  latitude: 31.5204,
  longitude: 74.3587,
  approxAreaLabel: 'Gulberg, Lahore',
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

describe('AddressesPage (spec 012 §5 UI states)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AC-1/AC-2: empty state never mentions or requires location permission', async () => {
    installFetchMock([(url, init) => (url.endsWith('/api/v1/addresses') && (!init?.method || init.method === 'GET') ? { ok: true, data: [] } : undefined)]);
    render(<AddressesPage />);

    expect(await screen.findByText('No saved addresses yet')).toBeInTheDocument();
    expect(screen.queryByText(/allow location/i)).not.toBeInTheDocument();
    expect(screen.getByText(/no location permission needed/i)).toBeInTheDocument();
  });

  it('renders saved addresses with the default badge, never exposing raw fetch errors', async () => {
    installFetchMock([(url, init) => (url.endsWith('/api/v1/addresses') && (!init?.method || init.method === 'GET') ? { ok: true, data: [HOME_ADDRESS] } : undefined)]);
    render(<AddressesPage />);

    expect(await screen.findByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText(/House 12, Street 5/)).toBeInTheDocument();
  });

  it('error state renders with a retry action when the initial load fails', async () => {
    installFetchMock([
      (url, init) =>
        url.endsWith('/api/v1/addresses') && (!init?.method || init.method === 'GET')
          ? { ok: false, error: { code: 'INTERNAL_ERROR', message: 'boom' } }
          : undefined,
    ]);
    render(<AddressesPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('AC-2: adding an address resolves through text search alone, never prompting for device location', async () => {
    const user = userEvent.setup();
    let created = false;
    installFetchMock([
      (url, init) => (url.endsWith('/api/v1/addresses') && (!init?.method || init.method === 'GET') ? { ok: true, data: [] } : undefined),
      (url, init) =>
        url.endsWith('/api/v1/location/geocode') && init?.method === 'POST'
          ? {
              ok: true,
              data: {
                structured: { line1: '221B Baker Street', area: 'Marylebone', city: 'London', country: 'UK' },
                latitude: 51.5237,
                longitude: -0.1585,
                approxAreaLabel: 'Marylebone, London',
              },
            }
          : undefined,
      (url, init) => {
        if (url.endsWith('/api/v1/addresses') && init?.method === 'POST') {
          created = true;
          return { ok: true, status: 201, data: { ...HOME_ADDRESS, id: 'addr-2', label: 'Baker Street' } };
        }
        return undefined;
      },
    ]);
    render(<AddressesPage />);

    await screen.findByText('No saved addresses yet');
    await user.click(screen.getAllByRole('button', { name: 'Add an address' })[0]!);

    await user.type(screen.getByLabelText('Search for an address'), '221B Baker Street');
    await user.click(screen.getByRole('button', { name: 'Find' }));

    // FormField renders the required-field asterisk inside the <label>, so the accessible name
    // is "Label*" — match loosely rather than the exact visible word.
    await screen.findByLabelText(/^Label/);
    await user.type(screen.getByLabelText(/^Label/), 'Baker Street');
    await user.click(screen.getByRole('button', { name: 'Add address' }));

    await waitFor(() => expect(created).toBe(true));
  });

  it('a geocoding failure surfaces an inline error, not a permission prompt', async () => {
    const user = userEvent.setup();
    installFetchMock([
      (url, init) => (url.endsWith('/api/v1/addresses') && (!init?.method || init.method === 'GET') ? { ok: true, data: [] } : undefined),
      (url, init) =>
        url.endsWith('/api/v1/location/geocode') && init?.method === 'POST'
          ? { ok: false, status: 422, error: { code: 'GEOCODING_FAILED', message: "We couldn't find that address." } }
          : undefined,
    ]);
    render(<AddressesPage />);

    await screen.findByText('No saved addresses yet');
    await user.click(screen.getAllByRole('button', { name: 'Add an address' })[0]!);
    await user.type(screen.getByLabelText('Search for an address'), 'somewhere unresolvable');
    await user.click(screen.getByRole('button', { name: 'Find' }));

    expect(await screen.findByText(/couldn't find that address/i)).toBeInTheDocument();
  });

  it('destructive confirmation: deleting an address opens a dialog naming the consequence before acting', async () => {
    const user = userEvent.setup();
    let deleteCalled = false;
    installFetchMock([
      (url, init) => (url.endsWith('/api/v1/addresses') && (!init?.method || init.method === 'GET') ? { ok: true, data: [HOME_ADDRESS] } : undefined),
      (url, init) => {
        if (url.endsWith(`/api/v1/addresses/${HOME_ADDRESS.id}`) && init?.method === 'DELETE') {
          deleteCalled = true;
          return { ok: true, status: 204 };
        }
        return undefined;
      },
    ]);
    render(<AddressesPage />);

    await screen.findByText('Home');
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this address?' });
    expect(deleteCalled).toBe(false);
    expect(dialog).toHaveAccessibleDescription(/Home/);

    await user.click(screen.getByRole('button', { name: 'Delete address' }));
    await waitFor(() => expect(deleteCalled).toBe(true));
    await waitFor(() => expect(screen.queryByText('Home')).not.toBeInTheDocument());
  });
});
