'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Icon, Skeleton } from '@/components';
import type { FileAssetDto, FileUrlDto } from '@/lib/types/files';
import styles from './media-preview.module.css';

/**
 * Spec 027 §5 — renders a READY asset, and nothing else.
 *
 * A private asset's URL is fetched on demand from `GET /files/{id}` and REFRESHED shortly before it
 * expires; it is never cached in `localStorage`, because a signed URL is a credential bound to one
 * user with a short life, and persisting it would outlive both facts.
 *
 * A non-image kind renders a labelled file row rather than a broken image — the browser cannot show
 * a PDF or MP4 in an `<img>`, and pretending otherwise produces a broken-image icon that tells the
 * user nothing. Nothing here is conveyed by colour alone.
 */
export interface MediaPreviewProps {
  asset: FileAssetDto;
  /** Overridable so a consuming spec can point at its own proxy if it ever needs to. */
  urlEndpoint?: (fileAssetId: string) => string;
  /** How long before expiry to refresh a signed URL. */
  refreshMarginMs?: number;
}

export const DEFAULT_REFRESH_MARGIN_MS = 30_000;

function defaultUrlEndpoint(fileAssetId: string): string {
  return `/api/v1/files/${fileAssetId}`;
}

export function MediaPreview({
  asset,
  urlEndpoint = defaultUrlEndpoint,
  refreshMarginMs = DEFAULT_REFRESH_MARGIN_MS,
}: MediaPreviewProps) {
  const [url, setUrl] = useState<FileUrlDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(urlEndpoint(asset.id), { headers: { accept: 'application/json' } });
      if (!res.ok) {
        // The server's answer is authoritative: a 404 here means the asset is gone or no longer
        // readable by this caller, and the component says so rather than retrying forever.
        setError(res.status === 404 ? 'This file is no longer available.' : 'This file could not be loaded.');
        return;
      }
      const body = (await res.json()) as { data: FileUrlDto };
      setUrl(body.data);
    } catch {
      setError('This file could not be loaded.');
    }
  }, [asset.id, urlEndpoint]);

  useEffect(() => {
    // Only a `ready` asset has a URL at all — the server answers 409 for anything else.
    if (asset.status !== 'ready') return;
    void load();
  }, [asset.status, load]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!url?.expiresAt) return undefined;

    // A signed URL expires; refresh it just before it does, so an open page keeps working without
    // ever holding a long-lived credential.
    const delay = Math.max(1000, new Date(url.expiresAt).getTime() - Date.now() - refreshMarginMs);
    timer.current = setTimeout(() => void load(), delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [url, refreshMarginMs, load]);

  if (asset.status !== 'ready') {
    return (
      <div className={styles.preview} data-status={asset.status}>
        <Badge tone="neutral">{asset.status === 'rejected' ? 'Rejected' : 'Still checking this file'}</Badge>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.preview}>
        <Alert tone="error" title="File unavailable">
          {error}
        </Alert>
      </div>
    );
  }

  if (!url) {
    return (
      <div className={styles.preview}>
        <Skeleton height={120} />
      </div>
    );
  }

  if (asset.kind === 'image') {
    return (
      <figure className={styles.preview}>
        {/* eslint-disable-next-line @next/next/no-img-element -- the src is a short-lived signed URL
            or an external CDN URL resolved at runtime; next/image cannot pre-optimize either. */}
        <img className={styles.image} src={url.url} alt={asset.fileName ?? 'Attached image'} />
      </figure>
    );
  }

  // A document or video: a labelled row, never an <img> that would render broken.
  return (
    <a className={styles.fileRow} href={url.url} target="_blank" rel="noopener noreferrer">
      <Icon name={asset.kind === 'video' ? 'video' : 'file'} aria-hidden />
      <span className={styles.fileName}>{asset.fileName ?? 'Attached file'}</span>
      <Badge tone="neutral">{asset.kind === 'video' ? 'Video' : 'Document'}</Badge>
    </a>
  );
}
