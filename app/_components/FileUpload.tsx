'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, Icon } from '@/components';
import { ProgressBar } from '@/components/ProgressBar';
import type { FileAssetDto, FileContextType, FileKind, UploadTargetDto } from '@/lib/types/files';
import { MediaPreview } from './MediaPreview';
import styles from './file-upload.module.css';

/**
 * Spec 027 §5 — the upload control, and specifically AC-5's honesty rule:
 *
 *   **A client-side "100%" never means done.** Bytes-sent progress is real — it comes from
 *   `XMLHttpRequest.upload`'s `progress` events, not a timer — but when it reaches 100% the file is
 *   merely *uploaded*, not *accepted*. The control then shows "Checking file…" until the server's
 *   `finalize` response comes back, and shows the file as attached only on that response. If the
 *   server rejects it (wrong type, too large, failed scan), the user is told the specific reason.
 *
 * `XMLHttpRequest` rather than `fetch` deliberately: `fetch` has no upload-progress event, so a
 * determinate bar built on it would be a fiction. An indefinite spinner is what this avoids.
 *
 * This component is standalone (§7): it is embedded by a consuming spec, and modifies no page here.
 */
export interface FileUploadProps {
  contextType: FileContextType;
  contextId: string | null;
  /** Client-side pre-filter only. The server's allowlist remains authoritative. */
  accept?: string;
  kindOf?: (file: File) => FileKind;
  maxBytes?: number;
  maxFiles?: number;
  /** Called with the authoritative server-confirmed assets, whenever they change. */
  onChange?: (assets: FileAssetDto[]) => void;
  label?: string;
  visibility?: 'public' | 'private';
}

type ItemState =
  | { phase: 'uploading'; percent: number }
  /** Bytes are sent; the server has not answered yet. This is where "100%" stops meaning done. */
  | { phase: 'finalizing' }
  | { phase: 'done'; asset: FileAssetDto }
  | { phase: 'error'; message: string };

interface Item {
  key: string;
  fileName: string;
  state: ItemState;
}

const DEFAULT_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

function defaultKindOf(file: File): FileKind {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'document';
}

/** Turns this spec's error codes into something a person can act on. */
function messageForError(code: string | undefined, fallback: string): string {
  switch (code) {
    case 'FILE_TYPE_NOT_ALLOWED':
      return 'That file type is not accepted here.';
    case 'FILE_TOO_LARGE':
      return 'That file is too large.';
    case 'FILE_REJECTED':
      return 'This file did not pass our security check and cannot be attached.';
    case 'FILE_CONTEXT_LIMIT_REACHED':
      return 'You have already attached the maximum number of files here.';
    case 'FILE_STORAGE_UNAVAILABLE':
      return 'File storage is unavailable right now. Please try again shortly.';
    case 'RATE_LIMITED':
      return 'Too many uploads just now. Please wait a moment and try again.';
    default:
      return fallback;
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

export function FileUpload({
  contextType,
  contextId,
  accept = DEFAULT_ACCEPT,
  kindOf = defaultKindOf,
  maxBytes = DEFAULT_MAX_BYTES,
  maxFiles = 5,
  onChange,
  label = 'Attachments',
  visibility,
}: FileUploadProps) {
  const [items, setItems] = useState<Item[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const inputId = useId();

  const update = useCallback(
    (key: string, state: ItemState) => {
      setItems((current) => {
        const next = current.map((item) => (item.key === key ? { ...item, state } : item));
        onChange?.(next.flatMap((item) => (item.state.phase === 'done' ? [item.state.asset] : [])));
        return next;
      });
    },
    [onChange],
  );

  const uploadBytes = useCallback((target: UploadTargetDto, file: File, key: string) => {
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(target.upload.method, target.upload.url);
      for (const [header, value] of Object.entries(target.upload.headers)) xhr.setRequestHeader(header, value);

      // REAL bytes-sent events — this is what makes the bar determinate rather than decorative.
      xhr.upload.addEventListener('progress', (event) => {
        if (!event.lengthComputable) return;
        update(key, { phase: 'uploading', percent: Math.round((event.loaded / event.total) * 100) });
      });
      xhr.addEventListener('load', () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('upload_failed'))));
      xhr.addEventListener('error', () => reject(new Error('upload_failed')));
      xhr.addEventListener('abort', () => reject(new Error('upload_aborted')));
      xhr.send(file);
    });
  }, [update]);

  const uploadOne = useCallback(
    async (file: File, key: string) => {
      const csrf = readCsrfCookie();
      const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf, 'idempotency-key': key };

      try {
        const reserveRes = await fetch('/api/v1/files/upload-url', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            kind: kindOf(file),
            mimeType: file.type,
            sizeBytes: file.size,
            fileName: file.name,
            contextType,
            contextId,
            ...(visibility ? { visibility } : {}),
          }),
        });
        if (!reserveRes.ok) {
          const body = await reserveRes.json().catch(() => ({}));
          update(key, { phase: 'error', message: messageForError(body.code, 'This file could not be uploaded.') });
          return;
        }
        const { data: target } = (await reserveRes.json()) as { data: UploadTargetDto };

        update(key, { phase: 'uploading', percent: 0 });
        await uploadBytes(target, file, key);

        // Bytes are sent. The file is NOT attached yet, and the UI says exactly that.
        update(key, { phase: 'finalizing' });

        const finalizeRes = await fetch(`/api/v1/files/${target.fileAsset.id}/finalize`, {
          method: 'POST',
          headers: { 'x-csrf-token': csrf },
        });
        if (!finalizeRes.ok) {
          const body = await finalizeRes.json().catch(() => ({}));
          update(key, { phase: 'error', message: messageForError(body.code, 'This file could not be attached.') });
          return;
        }
        const { data: asset } = (await finalizeRes.json()) as { data: FileAssetDto };

        if (asset.status === 'rejected') {
          update(key, { phase: 'error', message: messageForError('FILE_REJECTED', 'This file was rejected.') });
          return;
        }
        // `scanning` is a legitimate outcome and is shown as such — not as success.
        update(key, { phase: 'done', asset });
      } catch {
        update(key, { phase: 'error', message: 'The upload did not complete. You can try this file again.' });
      }
    },
    [contextType, contextId, kindOf, update, uploadBytes, visibility],
  );

  const onSelect = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      for (const file of Array.from(files)) {
        const key = crypto.randomUUID();
        // An obviously-wrong file is reported instantly and never uploaded. The server check stays
        // authoritative — this only spares the user a round trip.
        const tooLarge = file.size > maxBytes;
        const wrongType = accept.length > 0 && !accept.split(',').some((allowed) => allowed.trim() === file.type);

        setItems((current) => {
          if (current.length >= maxFiles) return current;
          return [...current, { key, fileName: file.name, state: { phase: 'uploading', percent: 0 } }];
        });

        if (tooLarge) {
          update(key, { phase: 'error', message: `That file is larger than the ${formatBytes(maxBytes)} limit.` });
          continue;
        }
        if (wrongType) {
          update(key, { phase: 'error', message: 'That file type is not accepted here.' });
          continue;
        }
        void uploadOne(file, key);
      }
      if (inputRef.current) inputRef.current.value = '';
    },
    [accept, maxBytes, maxFiles, update, uploadOne],
  );

  /** Removing one failed file must never disturb the others that already succeeded. */
  const remove = useCallback(
    (key: string) => {
      setItems((current) => {
        const next = current.filter((item) => item.key !== key);
        onChange?.(next.flatMap((item) => (item.state.phase === 'done' ? [item.state.asset] : [])));
        return next;
      });
    },
    [onChange],
  );

  return (
    <Card className={styles.upload}>
      <div className={styles.header}>
        <span className={styles.label} id={`${inputId}-label`}>
          {label}
        </span>
        {/* The allowed types and the size cap are stated BEFORE selection, not after a rejection. */}
        <span className={styles.hint}>
          Up to {maxFiles} files, {formatBytes(maxBytes)} each. Accepted: {accept.replaceAll(',', ', ')}
        </span>
      </div>

      {items.length === 0 ? <EmptyState title="No attachments yet" description="Add a file to attach it here." /> : null}

      <ul className={styles.list}>
        {items.map((item) => (
          <li key={item.key} className={styles.item} data-phase={item.state.phase}>
            <div className={styles.itemHeader}>
              <Icon name="paperclip" />
              <span className={styles.itemName}>{item.fileName}</span>
              <Button variant="ghost" size="sm" onClick={() => remove(item.key)} aria-label={`Remove ${item.fileName}`}>
                Remove
              </Button>
            </div>

            {item.state.phase === 'uploading' ? (
              <ProgressBar value={item.state.percent} label={`Uploading ${item.fileName}`} showValue />
            ) : null}

            {item.state.phase === 'finalizing' ? (
              // 100% of the bytes are sent; the server has not confirmed. Never "Done".
              <p className={styles.status} role="status">
                Checking file…
              </p>
            ) : null}

            {item.state.phase === 'done' && item.state.asset.status === 'scanning' ? (
              <p className={styles.status} role="status">
                Still checking this file
              </p>
            ) : null}

            {item.state.phase === 'done' && item.state.asset.status === 'ready' ? (
              <MediaPreview asset={item.state.asset} />
            ) : null}

            {item.state.phase === 'error' ? (
              <Alert tone="error" title="This file was not attached">
                {item.state.message}
              </Alert>
            ) : null}
          </li>
        ))}
      </ul>

      <div className={styles.actions}>
        <input
          ref={inputRef}
          id={inputId}
          className={styles.input}
          type="file"
          multiple
          accept={accept}
          aria-labelledby={`${inputId}-label`}
          onChange={(event) => onSelect(event.target.files)}
        />
        <Badge tone="neutral">
          {items.filter((item) => item.state.phase === 'done').length} of {maxFiles} attached
        </Badge>
      </div>
    </Card>
  );
}
