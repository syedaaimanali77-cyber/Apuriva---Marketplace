// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { FileAssetDto } from '@/lib/types/files';
import { MediaPreview } from './MediaPreview';

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

function stubUrl(body: unknown, status = 200) {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify({ data: body }), { status, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Spec 027 §5 — a preview exists only for a READY asset, and a private URL is never persisted. */
describe('MediaPreview (spec 027 §5)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders an image for a ready image asset', async () => {
    stubUrl({ url: '/api/v1/files/x/content?sig=1', expiresAt: new Date(Date.now() + 300_000).toISOString(), visibility: 'private' });
    render(<MediaPreview asset={asset()} />);

    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', '/api/v1/files/x/content?sig=1');
    // The file name is the alt text, so the image is not silent to a screen reader.
    expect(img).toHaveAttribute('alt', 'photo.jpg');
  });

  it('a non-image kind renders a labelled file row, not a broken image', async () => {
    stubUrl({ url: '/api/v1/files/x/content?sig=1', expiresAt: null, visibility: 'private' });
    render(<MediaPreview asset={asset({ kind: 'document', mimeType: 'application/pdf', fileName: 'invoice.pdf' })} />);

    await waitFor(() => expect(screen.getByText('invoice.pdf')).toBeInTheDocument());
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/api/v1/files/x/content?sig=1');
    // Labelled in text, not by colour alone.
    expect(screen.getByText('Document')).toBeInTheDocument();
  });

  it('never fetches a url for a non-ready asset, and says why', () => {
    const fetchMock = stubUrl({});
    render(<MediaPreview asset={asset({ status: 'scanning', readyAt: null })} />);

    expect(screen.getByText('Still checking this file')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a rejected asset shows as rejected and never previews', () => {
    const fetchMock = stubUrl({});
    render(<MediaPreview asset={asset({ status: 'rejected', readyAt: null, rejectionReason: 'test_marker' })} />);

    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 404 from the server is reported as unavailable, not retried into a loop', async () => {
    const fetchMock = stubUrl({}, 404);
    render(<MediaPreview asset={asset()} />);

    await waitFor(() => expect(screen.getByText('This file is no longer available.')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never caches a signed url in localStorage', async () => {
    stubUrl({ url: '/api/v1/files/x/content?sig=secret', expiresAt: new Date(Date.now() + 300_000).toISOString(), visibility: 'private' });
    render(<MediaPreview asset={asset()} />);
    await screen.findByRole('img');

    // A signed URL is a short-lived credential bound to one user; persisting it would outlive both.
    expect(JSON.stringify(localStorage)).not.toContain('sig=secret');
    expect(localStorage.length).toBe(0);
  });

  it('refreshes a signed url before it expires', async () => {
    // Real timers with a deliberately tiny window: the refresh is scheduled from the URL's own
    // `expiresAt`, and the component floors the delay at 1s so it can never spin.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { url: '/api/v1/files/x/content?sig=1', expiresAt: new Date(Date.now() + 1200).toISOString(), visibility: 'private' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<MediaPreview asset={asset()} refreshMarginMs={1000} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
  });

  it('a public CDN url has no expiry and is therefore never refreshed', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { url: 'https://cdn.example.test/x?w=1600&q=80', expiresAt: null, visibility: 'public' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      render(<MediaPreview asset={asset({ visibility: 'public' })} />);

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(600_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
