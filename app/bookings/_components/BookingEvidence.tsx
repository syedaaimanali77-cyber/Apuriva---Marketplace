'use client';

/**
 * Spec 028 §5 — completion evidence: the provider's capture control mid-job, and the read view both
 * parties get afterwards.
 *
 * Built entirely from what already exists: spec 027's `FileUpload`/`MediaPreview` (there is no
 * `EvidenceUpload` component and none is created) and the existing `bookings.module.css`. It adds
 * no page and no `ui/` primitive, and carries no logo of its own.
 *
 * WHAT THE SCREEN PROMISES AND WHAT IT DOES NOT. The provider is told BEFORE pressing "Mark
 * complete" that evidence is required and how much is attached, so a `422 COMPLETION_EVIDENCE_REQUIRED`
 * is a backstop rather than the first they hear of it. But this component decides nothing: the
 * requirement and its satisfaction are resolved server-side from the catalog, inside the completion
 * transaction, and a client that lied about either would simply be refused (AC-4).
 *
 * The customer sees no evidence section at all before completion — the server returns an empty list
 * until then (AC-8), so there is nothing to render and nothing to hint at.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge, Card } from '@/components';
import { FileUpload } from '@/app/_components/FileUpload';
import { MediaPreview } from '@/app/_components/MediaPreview';
import type { FileAssetDto } from '@/lib/types/files';
import type { BookingStatus } from '@/lib/types/bookings';
import { apiFetch } from '@/app/bookings/booking-client';
import styles from '@/app/bookings/bookings.module.css';

/** Mirrors `EXECUTING_BOOKING_STATUSES` — the server remains authoritative. */
const CAPTURABLE_STATUSES: readonly BookingStatus[] = ['arrived', 'in_progress'];

/** Mirrors `MAX_BOOKING_EVIDENCE_ASSETS`; spec 027 enforces the real cap at `upload-url`. */
const MAX_EVIDENCE_FILES = 10;

export interface BookingEvidenceProps {
  bookingId: string;
  status: BookingStatus;
  viewerRole: 'customer' | 'provider';
  /** True when this booking's service requires evidence, so the copy can say so up front. */
  evidenceRequired?: boolean;
  /** Lets the provider page keep the ids it will send with `complete`. */
  onAssetsChange?: (assets: FileAssetDto[]) => void;
}

export function BookingEvidence({
  bookingId,
  status,
  viewerRole,
  evidenceRequired = false,
  onAssetsChange,
}: BookingEvidenceProps) {
  const [assets, setAssets] = useState<FileAssetDto[]>([]);

  const load = useCallback(async () => {
    let next: FileAssetDto[] = [];
    try {
      const result = await apiFetch<FileAssetDto[]>(`/api/v1/bookings/${bookingId}/evidence`);
      // Defensive: only ever hold a list. A route that answered with anything else, or a dropped
      // connection, leaves the section empty rather than throwing inside render.
      if (result.ok && Array.isArray(result.data)) next = result.data;
    } catch {
      next = [];
    }
    setAssets(next);
    onAssetsChange?.(next);
  }, [bookingId, onAssetsChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const canCapture = viewerRole === 'provider' && CAPTURABLE_STATUSES.includes(status);
  const readyCount = assets.filter((asset) => asset.status === 'ready').length;

  // Nothing to show and nothing to do: render nothing rather than an empty shell.
  if (!canCapture && assets.length === 0) return null;

  return (
    <Card>
      <h2 className={styles.sectionTitle}>Completion evidence</h2>

      {canCapture && (
        <>
          <p className={styles.hint}>
            {evidenceRequired
              ? 'This service needs at least one photo, video or document attached before you can mark it complete.'
              : 'Optional. Attach a photo, video or document if it helps show what was done.'}
          </p>
          <p className={styles.hint} role="status" aria-live="polite">
            {readyCount === 0
              ? 'Nothing attached yet.'
              : `${readyCount} file${readyCount === 1 ? '' : 's'} attached.`}
          </p>
          <FileUpload
            contextType="booking_evidence"
            contextId={bookingId}
            label="Evidence"
            maxFiles={MAX_EVIDENCE_FILES}
            accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf"
            onChange={() => void load()}
          />
        </>
      )}

      {assets.length > 0 && (
        <ul className={styles.historyList}>
          {assets.map((asset) => (
            <li key={asset.id} className={styles.historyRow}>
              {asset.status === 'ready' ? (
                <MediaPreview asset={asset} />
              ) : (
                // Spec 027 owns what a not-yet-ready asset means; never a broken image.
                <Badge>{asset.status === 'rejected' ? 'File rejected' : 'Still checking this file'}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
