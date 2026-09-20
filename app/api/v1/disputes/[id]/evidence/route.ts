import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { rateLimitedError } from '@/lib/api/errors';
import { checkRateLimit } from '@/lib/api/rate-limit';
import { idempotencyFingerprint, requireIdempotencyKey } from '@/lib/api/idempotency';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import {
  linkEvidence,
  listEvidenceForAdmin,
  listEvidenceForParticipant,
  parseEvidenceLinkRequest,
} from '@/lib/disputes';
import { disputeIdFromUrl, isParticipantOf } from '../../dispute-id';

/**
 * Spec 031 §3 "Evidence" (AC-3, DECIDED-6), `POST /api/v1/disputes/{id}/evidence`.
 *
 * BYTES NEVER PASS THROUGH THIS ROUTE. Spec 027 owns the whole pipeline: the client calls
 * `POST /files/upload-url` with `contextType: 'dispute_evidence'` and `contextId: <disputeId>`,
 * uploads, then `POST /files/{id}/finalize`. This route records that the finalized asset belongs to
 * the dispute. There is no second storage system and no new media route.
 *
 * `lib/disputes/evidence-policy.ts` is what authorized the upload in the first place, and
 * `linkEvidence` re-checks ownership here — not redundantly, but because that is what stops a
 * caller pointing the link at somebody else's asset id after the fact.
 *
 * Only a participant may attach. An admin has no upload path: evidence is the parties' material,
 * and an admin who wants something on the record posts a message instead.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const disputeId = disputeIdFromUrl(request, 1);
  const key = requireIdempotencyKey(request);
  const body = await request.json().catch(() => ({}));
  const input = parseEvidenceLinkRequest(body);

  const { evidence, replayed } = await linkEvidence(disputeId, session.userId, input, {
    key,
    fingerprint: idempotencyFingerprint(input),
  });

  return apiSuccess(evidence, correlationId, { status: replayed ? 200 : 201 });
});

/**
 * `GET /api/v1/disputes/{id}/evidence` — the list.
 *
 * BOTH PARTICIPANTS SEE BOTH SIDES' EVIDENCE. This is the deliberate, load-bearing difference from
 * spec 030, where the reported user never learns a report exists: a dispute is
 * adversarial-but-mutual, and master §2.3's explainability plus plain fairness require that a party
 * can see what is being argued against them.
 *
 * This returns the linkage rows. The BYTES are fetched through spec 027's
 * `GET /files/{id}/content`, which re-runs `disputeEvidencePolicy.canRead` on every fetch and
 * audits an admin read BEFORE disclosing anything.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);

  const limit = checkRateLimit('disputes', session.userId);
  if (!limit.allowed) throw rateLimitedError(limit.retryAfterSeconds);

  const disputeId = disputeIdFromUrl(request, 1);
  const page = parsePageParams(new URL(request.url).searchParams);

  const { items, total } = (await isParticipantOf(disputeId, session.userId))
    ? await listEvidenceForParticipant(disputeId, session.userId, page)
    : await listEvidenceForAdmin(disputeId, session.userId, page, correlationId);

  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
