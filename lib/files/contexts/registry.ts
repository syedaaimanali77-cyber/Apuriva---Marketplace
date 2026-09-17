/**
 * Spec 027 §3 "Context authorization" (AC-6, AC-8) — the registry that keeps this spec from ever
 * encoding another spec's business rules.
 *
 * A `context_type` is a closed vocabulary at the database (C-2), but a value being *spellable* is
 * not the same as it being *usable*: an upload is accepted only while a policy is REGISTERED for
 * that context. So `booking_evidence`, `dispute_evidence` and `verification_document` are `422
 * FILE_CONTEXT_NOT_AVAILABLE` and create NO ROW until 028/029/031 register theirs — which is what
 * stops `context_type` from becoming an authorization bypass (§8 #5): there can never exist an
 * asset whose reader nobody knows how to authorize.
 *
 * `canRead` is re-run on every URL issue AND every content fetch (AC-6), so a policy is the live
 * answer to "may this caller see this", never a decision cached at upload time.
 */
import type { ActiveMode } from '@/lib/types/users';
import type { FileContextType, FileKind } from '@/lib/types/files';
import type { FileAssetRow } from '../assets';

export interface FileContextPolicy {
  /** May this context ever be public? Only `portfolio` is true today (AC-2). */
  publicEligible: boolean;
  maxPerContext: number;
  allowedKinds: readonly FileKind[];
  /** May this caller ATTACH to this context id? Checked at `upload-url`, before any row exists. */
  canUpload(input: { userId: string; activeMode: ActiveMode; contextId: string | null }): Promise<boolean>;
  /**
   * May this caller READ this asset? Re-run on every URL issue and every content fetch.
   * `correlationId` is carried so a policy whose read must be AUDITED (spec 025's admin path) can
   * link its audit entry back to the originating request, exactly as spec 025 does.
   */
  canRead(input: {
    userId: string;
    activeMode: ActiveMode;
    asset: FileAssetRow;
    correlationId?: string | null;
  }): Promise<boolean>;
}

const policies = new Map<FileContextType, FileContextPolicy>();

/** Idempotent by design: re-registering a context replaces its policy rather than erroring, so a
 * hot-reloaded dev server and a repeated `register()` both converge on one policy per context. */
export function registerFileContextPolicy(type: FileContextType, policy: FileContextPolicy): void {
  policies.set(type, policy);
}

export function getFileContextPolicy(type: FileContextType): FileContextPolicy | null {
  return policies.get(type) ?? null;
}

export function registeredFileContextTypes(): FileContextType[] {
  return [...policies.keys()];
}

/** Test-only: clears the registry so suites do not leak registrations into each other. */
export function resetFileContextPolicies(): void {
  policies.clear();
}
