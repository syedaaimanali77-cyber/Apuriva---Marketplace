/** Spec 008 §3 request/response types. */
export interface SessionSummaryDto {
  id: string;
  deviceLabel: string | null;
  /** Coarse only (e.g. a city/region label) — never a precise GPS coordinate, street-level
   * location, or the raw IP address. Always `null` today: no geolocation source is derived from
   * `Session.ip_hash` (a one-way hash, spec 005 §4 — there is nothing to reverse into a location)
   * and this spec does not add a geolocation lookup service. */
  approxLocation: string | null;
  lastActiveAt: string;
  isCurrent: boolean;
}

export type DataExportStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface DataExportStatusDto {
  status: DataExportStatus;
  /** Private, signed, time-limited — present only once `status` is `ready`. */
  downloadUrl?: string;
  expiresAt?: string;
}

export interface RequestDeletionResponse {
  gracePeriodEndsAt: string;
}

export interface MfaToggleRequest {
  enabled: boolean;
}

export interface MfaToggleResponse {
  mfaEnabled: boolean;
}
