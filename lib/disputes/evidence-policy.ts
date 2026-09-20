/**
 * Spec 031 §3 "Evidence" (AC-3, DECIDED-6) — the resolver that lifts spec 027's `dispute_evidence`
 * context out of `422 FILE_CONTEXT_NOT_AVAILABLE`.
 *
 * WHY IT LIVES HERE AND NOT IN `lib/files/contexts/`. Spec 027 §3 makes the consuming spec the
 * owner of "who may see a file in a given context", and `lib/files/boundaries.test.ts` enforces
 * that `lib/files/**` never acquires a consuming spec's business rules. Who may attach evidence to
 * a dispute, and who may then look at it, is a SPEC 031 rule — written here and handed to spec
 * 027's registry from the composition root. Spec 027's source is untouched, and unlike spec 030
 * this spec does not even widen its vocabulary: `dispute_evidence` has been in
 * `file_assets_context_type_ck` since `0001_baseline_schema.sql`.
 *
 * `contextId` is the DISPUTE id. The dispute is created first (one POST) and evidence is attached
 * afterwards; the UI performs both behind one submit, exactly as spec 030 does.
 *
 * THE TWO RULES:
 *
 *   UPLOAD — a participant of the dispute's booking, while the dispute is `open`, `under_review` or
 *   `appealed`. `resolved` is excluded and `appealed` included deliberately: a decided case is
 *   frozen, but an appeal is precisely the stage that exists to admit new material.
 *
 *   READ — BOTH PARTICIPANTS, each other's included. This is the load-bearing difference from spec
 *   030, where the reported user never learns a report exists. A dispute is adversarial-but-mutual:
 *   master §2.3's explainability and plain fairness both require that a party can see what is being
 *   argued against them, and a participant who cannot see the evidence cannot meaningfully appeal.
 *   An admin holding `disputes/read` also reads, and that read is AUDITED BEFORE THE BYTES ARE
 *   DISCLOSED — the pattern spec 025's `messageAttachmentPolicy` and spec 030's
 *   `safetyEvidencePolicy` established. An admin who is a participant reads NOTHING here: the
 *   `DISPUTE_PARTICIPANT_CONFLICT` rule is enforced as a boolean refusal rather than a throw,
 *   because this hook returns a boolean.
 *
 * DELETION IS REFUSED WHILE THE DISPUTE IS LIVE. Spec 027's `DELETE /files/{id}` consults
 * `canRead`, and a party must not be able to withdraw evidence mid-argument.
 */
import { registerFileContextPolicy, type FileContextPolicy } from '@/lib/files/contexts/registry';
import { isUuid } from '@/lib/offers/validation';
import { DISPUTE_EVIDENCE_CONTEXT, MAX_DISPUTE_EVIDENCE } from './limits';
import { hasDisputeReadPermission } from './permissions';
import { auditDispute, DISPUTE_EVENT_TYPES, isDisputeParticipant, loadDisputeOwnership } from './read';
import { isContributable } from './transitions';

export const disputeEvidencePolicy: FileContextPolicy = {
  /** Dispute evidence is never public, in any circumstance. */
  publicEligible: false,
  maxPerContext: MAX_DISPUTE_EVIDENCE,
  /** Whatever the party actually has: a photo, a document, a recording. Narrowing it discards evidence. */
  allowedKinds: ['image', 'document', 'video'],

  async canUpload({ userId, contextId }) {
    if (!contextId || !isUuid(contextId)) return false;
    const ownership = await loadDisputeOwnership(contextId);
    if (!ownership) return false;
    // Either mode: a disagreement is not role-scoped, and forcing a mode switch mid-argument is a
    // barrier at exactly the wrong moment.
    if (!isDisputeParticipant(ownership, userId)) return false;
    return isContributable(ownership.status);
  },

  async canRead({ userId, asset, correlationId }) {
    const contextId = asset.context_id;
    if (!contextId) return false;
    const ownership = await loadDisputeOwnership(contextId);
    if (!ownership) return false;

    // Both sides read everything attached to their own dispute (DECIDED-6).
    if (isDisputeParticipant(ownership, userId)) return true;

    // Anyone else needs the permission — and the read is recorded before the bytes move.
    if (!(await hasDisputeReadPermission(userId))) return false;
    await auditDispute({
      actorUserId: userId,
      eventType: DISPUTE_EVENT_TYPES.evidenceRead,
      targetId: contextId,
      correlationId: correlationId ?? null,
      details: { fileAssetId: asset.id },
    });
    return true;
  },
};

/** Called from `registerDisputeIntegration()`; never from `lib/files`. */
export function registerDisputeEvidenceContext(): void {
  registerFileContextPolicy(DISPUTE_EVIDENCE_CONTEXT, disputeEvidencePolicy);
}
