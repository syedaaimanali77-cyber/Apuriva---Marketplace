import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import { confirmMemory, listMemory, resetMemory } from '@/lib/ai-assistant';
import { enforceDefaultRateLimit, noContent } from '../ai-route-support';

/** Spec 034 §3.9, `GET /api/v1/ai/memory` — small by construction, so unpaged. Never flag-gated. */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  enforceDefaultRateLimit(session.userId);
  return apiSuccess(await listMemory(session.userId), correlationId);
});

/**
 * Spec 034 §3.9, `POST /api/v1/ai/memory` (AC-13, AC-19) — the user's EXPLICIT confirmation of a
 * proposed item: `{ conversationId, key, value }`. Only the three allow-listed keys are accepted;
 * anything else is `400`. `conversationId` must be a stored, non-deleted conversation the caller owns
 * (`404` otherwise). Naturally idempotent on `(user, key)`: `201` created, `200` when replaced.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceDefaultRateLimit(session.userId);

  const body = await request.json().catch(() => ({}));
  const { item, created } = await confirmMemory(session.userId, body);
  return apiSuccess(item, correlationId, { status: created ? 201 : 200 });
});

/** Spec 034 §3.9, `DELETE /api/v1/ai/memory` — RESET (AC-3). Conversations are untouched. */
export const DELETE = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  enforceDefaultRateLimit(session.userId);

  await resetMemory(session.userId);
  return noContent(correlationId);
});
