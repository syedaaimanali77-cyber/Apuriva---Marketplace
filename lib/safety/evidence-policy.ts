/**
 * Spec 030 §3 "Evidence" (AC-3) — the resolver that lifts spec 027's `safety_evidence` context out
 * of `422 FILE_CONTEXT_NOT_AVAILABLE`.
 *
 * WHY IT LIVES HERE AND NOT IN `lib/files/contexts/`. Spec 027 §3 makes the consuming spec the
 * owner of "who may see a file in a given context", and `lib/files/boundaries.test.ts` enforces
 * that `lib/files/**` never acquires a consuming spec's business rules. Who may attach evidence to
 * a safety report, and who may then look at it, is a SPEC 030 rule — written here and handed to
 * spec 027's registry from the composition root. Spec 027's source is untouched; the only change to
 * it anywhere is one new value in a closed vocabulary.
 *
 * `contextId` is the SAFETY REPORT id. Unlike review media, a safety report has no pre-existing
 * parent to hang evidence from when there is no booking — so the report is created first (it is
 * already restricted-access, so pre-creation costs nothing) and evidence is attached to it. The UI
 * performs both steps behind one submit.
 *
 * The two rules:
 *
 *   UPLOAD — the report's own reporter, and only while the report is not `resolved`. Evidence
 *   cannot be bolted onto a closed case, and nobody but the reporter can put bytes into someone
 *   else's safety record.
 *
 *   READ — the reporter (their own attachments), or an admin holding `safety_reports/read`. The
 *   admin read is AUDITED BEFORE THE BYTES ARE DISCLOSED, the pattern spec 025's
 *   `messageAttachmentPolicy` established. The REPORTED USER never reads anything: there is no
 *   branch here that could admit them, because master §64 says they are never even told a report
 *   exists.
 *
 * `publicEligible` is false — the only correct answer for this context.
 */
import { registerFileContextPolicy, type FileContextPolicy } from '@/lib/files/contexts/registry';
import { isUuid } from '@/lib/offers/validation';
import type { FileAssetRow } from '@/lib/files/assets';
import { MAX_SAFETY_EVIDENCE, SAFETY_EVIDENCE_CONTEXT } from './limits';
import { hasSafetyReadPermission } from './permissions';
import { loadReportOwnership, auditSafety, SAFETY_EVENT_TYPES } from './reports';

export const safetyEvidencePolicy: FileContextPolicy = {
  /** Safety evidence is never public. Master §64. */
  publicEligible: false,
  maxPerContext: MAX_SAFETY_EVIDENCE,
  /** Whatever the reporter has: a screenshot, a document, a recording. Narrowing it discards evidence. */
  allowedKinds: ['image', 'document', 'video'],

  async canUpload({ userId, contextId }) {
    if (!contextId || !isUuid(contextId)) return false;
    const report = await loadReportOwnership(contextId);
    if (!report) return false;
    // Either mode: a safety concern is not role-scoped, and forcing a mode switch mid-report is a
    // barrier at exactly the wrong moment.
    if (report.reporterUserId !== userId) return false;
    return report.status !== 'resolved';
  },

  async canRead({ userId, asset, correlationId }) {
    const contextId = asset.context_id;
    if (!contextId) return false;
    const report = await loadReportOwnership(contextId);
    if (!report) return false;

    // The reporter may re-read what they themselves submitted.
    if (report.reporterUserId === userId) return true;

    // Anyone else needs the permission — and the read is recorded before the bytes move.
    if (!(await hasSafetyReadPermission(userId))) return false;
    await auditSafety({
      adminUserId: userId,
      eventType: SAFETY_EVENT_TYPES.evidenceRead,
      targetId: contextId,
      correlationId: correlationId ?? null,
      details: { fileAssetId: asset.id },
    });
    return true;
  },
};

/** Called from `registerSafetyIntegration()`; never from `lib/files`. */
export function registerSafetyEvidenceContext(): void {
  registerFileContextPolicy(SAFETY_EVIDENCE_CONTEXT, safetyEvidencePolicy);
}

/** Exported for the boundary test, which asserts the policy is not public-eligible. */
export type { FileAssetRow };
