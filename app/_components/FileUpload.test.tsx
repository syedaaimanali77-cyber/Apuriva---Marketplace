// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FileAssetDto } from '@/lib/types/files';
import { FileUpload } from './FileUpload';

/**
 * Spec 027 AC-5 — the UI must never claim completion the server has not confirmed.
 *
 * The fake `XMLHttpRequest` below emits REAL-shaped `upload.progress` events under the test's
 * control, and the `finalize` response is held open until the test releases it — which is how
 * "100% sent but not yet attached" becomes an observable state rather than a race.
 */

function asset(overrides: Partial<FileAssetDto> = {}): FileAssetDto {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    kind: 'image',
    visibility: 'private',
    status: 'ready',
    mimeType: 'image/jpeg',
    sizeBytes: 64,
    fileName: 'photo.jpg',
    contextType: 'request_attachment',
    contextId: '22222222-2222-2222-2222-222222222222',
    rejectionReason: null,
    createdAt: new Date().toISOString(),
    readyAt: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

interface FakeXhr {
  emitProgress: (loaded: number, total: number) => void;
  finish: () => void;
}

const xhrs: FakeXhr[] = [];

class MockXhr {
  status = 204;
  upload = { listeners: new Map<string, ((e: unknown) => void)[]>(), addEventListener(type: string, fn: (e: unknown) => void) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  } };
  private listeners = new Map<string, (() => void)[]>();

  open(): void {}
  setRequestHeader(): void {}
  addEventListener(type: string, fn: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(fn);
    this.listeners.set(type, existing);
  }
  send(): void {
    xhrs.push({
      emitProgress: (loaded, total) => {
        for (const fn of this.upload.listeners.get('progress') ?? []) fn({ lengthComputable: true, loaded, total });
      },
      finish: () => {
        for (const fn of this.listeners.get('load') ?? []) fn();
      },
    });
  }
}

function jpegFile(name = 'photo.jpg', size = 64): File {
  const file = new File([new Uint8Array(size)], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('FileUpload (spec 027 AC-5)', () => {
  let releaseFinalize: (() => void) | null = null;

  beforeEach(() => {
    xhrs.length = 0;
    releaseFinalize = null;
    document.cookie = 'apuriva_csrf=test-token';
    vi.stubGlobal('XMLHttpRequest', MockXhr as unknown as typeof XMLHttpRequest);
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => `key-${Math.random()}` });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** `upload-url` answers immediately; `finalize` waits for the test to release it. */
  function stubFetch(options: { finalizeStatus?: number; finalizeBody?: unknown; urlBody?: unknown } = {}) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input.includes('upload-url')) {
          return new Response(
            JSON.stringify({
              data: {
                fileAsset: asset({ status: 'pending', readyAt: null }),
                upload: { url: '/api/v1/files/x/content?sig=1', method: 'PUT', headers: {}, expiresAt: new Date(Date.now() + 60000).toISOString() },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (input.includes('finalize')) {
          await new Promise<void>((resolve) => {
            releaseFinalize = resolve;
          });
          return new Response(JSON.stringify({ data: options.finalizeBody ?? asset() }), {
            status: options.finalizeStatus ?? 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        // MediaPreview's `GET /files/{id}`.
        return new Response(
          JSON.stringify({ data: options.urlBody ?? { url: 'blob:preview', expiresAt: null, visibility: 'private' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
  }

  it('states the allowed types and size cap BEFORE selection', () => {
    render(<FileUpload contextType="request_attachment" contextId="c1" maxBytes={10 * 1024 * 1024} maxFiles={5} />);
    expect(screen.getByText(/Up to 5 files, 10 MB each/)).toBeInTheDocument();
    expect(screen.getByText(/image\/jpeg/)).toBeInTheDocument();
    expect(screen.getByText('No attachments yet')).toBeInTheDocument();
  });

  it('shows determinate progress from real bytes-sent events', async () => {
    stubFetch();
    render(<FileUpload contextType="request_attachment" contextId="c1" />);

    await userEvent.upload(screen.getByLabelText('Attachments'), jpegFile());
    await waitFor(() => expect(xhrs).toHaveLength(1));

    xhrs[0]!.emitProgress(25, 100);
    await waitFor(() => {
      const bar = screen.getByRole('progressbar');
      // Determinate: a real value, not an indefinite spinner.
      expect(bar).toHaveAttribute('aria-valuenow', '25');
    });

    xhrs[0]!.emitProgress(80, 100);
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '80'));
  });

  it('claims completion only after finalize returns', async () => {
    stubFetch();
    render(<FileUpload contextType="request_attachment" contextId="c1" />);

    await userEvent.upload(screen.getByLabelText('Attachments'), jpegFile());
    await waitFor(() => expect(xhrs).toHaveLength(1));

    // 100% of the bytes are sent.
    xhrs[0]!.emitProgress(100, 100);
    xhrs[0]!.finish();

    // The server has NOT answered — so the UI must not say the file is attached.
    await waitFor(() => expect(screen.getByText('Checking file…')).toBeInTheDocument());
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    // Now the server confirms.
    await waitFor(() => expect(releaseFinalize).not.toBeNull());
    releaseFinalize!();
    await waitFor(() => expect(screen.getByRole('img')).toBeInTheDocument());
    expect(screen.queryByText('Checking file…')).not.toBeInTheDocument();
  });

  it('a scanning asset shows no preview', async () => {
    stubFetch({ finalizeBody: asset({ status: 'scanning', readyAt: null }) });
    render(<FileUpload contextType="request_attachment" contextId="c1" />);

    await userEvent.upload(screen.getByLabelText('Attachments'), jpegFile());
    await waitFor(() => expect(xhrs).toHaveLength(1));
    xhrs[0]!.emitProgress(100, 100);
    xhrs[0]!.finish();
    await waitFor(() => expect(releaseFinalize).not.toBeNull());
    releaseFinalize!();

    await waitFor(() => expect(screen.getByText('Still checking this file')).toBeInTheDocument());
    // A file whose scan is unresolved is readable by nobody — including the person who uploaded it.
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('an obviously-too-large file is reported instantly and never uploaded', async () => {
    stubFetch();
    render(<FileUpload contextType="request_attachment" contextId="c1" maxBytes={1024} />);

    await userEvent.upload(screen.getByLabelText('Attachments'), jpegFile('big.jpg', 5000));

    await waitFor(() => expect(screen.getByText(/larger than the 1 KB limit/)).toBeInTheDocument());
    // No bytes left the browser: the server check stays authoritative but was not needed here.
    expect(xhrs).toHaveLength(0);
  });

  it('a server rejection is reported with its specific reason', async () => {
    stubFetch({ finalizeBody: asset({ status: 'rejected', readyAt: null, rejectionReason: 'test_marker' }) });
    render(<FileUpload contextType="request_attachment" contextId="c1" />);

    await userEvent.upload(screen.getByLabelText('Attachments'), jpegFile());
    await waitFor(() => expect(xhrs).toHaveLength(1));
    xhrs[0]!.emitProgress(100, 100);
    xhrs[0]!.finish();
    await waitFor(() => expect(releaseFinalize).not.toBeNull());
    releaseFinalize!();

    await waitFor(() => expect(screen.getByText(/did not pass our security check/)).toBeInTheDocument());
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('removing a failed file keeps the others', async () => {
    stubFetch();
    render(<FileUpload contextType="request_attachment" contextId="c1" maxBytes={1024} />);
    const input = screen.getByLabelText('Attachments');

    await userEvent.upload(input, jpegFile('too-big.jpg', 5000));
    await userEvent.upload(input, jpegFile('also-too-big.jpg', 6000));
    await waitFor(() => expect(screen.getAllByText(/larger than the 1 KB limit/)).toHaveLength(2));

    await userEvent.click(screen.getByRole('button', { name: 'Remove too-big.jpg' }));

    expect(screen.queryByText('too-big.jpg')).not.toBeInTheDocument();
    expect(screen.getByText('also-too-big.jpg')).toBeInTheDocument();
  });

  it('reports only server-confirmed assets through onChange', async () => {
    stubFetch();
    const seen: FileAssetDto[][] = [];
    render(<FileUpload contextType="request_attachment" contextId="c1" onChange={(assets) => seen.push(assets)} />);

    await userEvent.upload(screen.getByLabelText('Attachments'), jpegFile());
    await waitFor(() => expect(xhrs).toHaveLength(1));
    xhrs[0]!.emitProgress(100, 100);
    xhrs[0]!.finish();

    // Nothing is reported while the file is merely uploaded.
    expect(seen.every((batch) => batch.length === 0)).toBe(true);

    await waitFor(() => expect(releaseFinalize).not.toBeNull());
    releaseFinalize!();
    await waitFor(() => expect(seen.at(-1)).toHaveLength(1));
  });
});
