import { withApiRoute } from '@/lib/api/handler';
import { apiSuccess } from '@/lib/api/response';
import { validationError } from '@/lib/api/errors';
import { adminForbiddenError } from '@/lib/admin-rbac/errors';
import { getAdminProfileId } from '@/lib/admin-rbac/permissions';
import { requireCsrf, requireSession } from '@/lib/auth/require-session';
import {
  listCancellationPolicies,
  publishCancellationPolicy,
  requireCancellationPolicyConfigurePermission,
  requireCancellationPolicyReadPermission,
} from '@/lib/cancellation';
import { POLICY_SCOPES, type PolicyScope } from '@/lib/types/cancellation';

/**
 * Spec 023 §3 "Configuration ownership", `GET /api/v1/admin/cancellation-policies`.
 *
 * Spec 023 owns the policy DATA and this API; spec 041 owns the later configuration UI. That is
 * what keeps the system executable today and removes the draft's circular dependency on a future
 * spec — the seed plus these two handlers are everything an operator needs.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  await requireCancellationPolicyReadPermission(session.userId);

  const policies = await listCancellationPolicies();
  return apiSuccess(policies, correlationId);
});

/**
 * `POST /api/v1/admin/cancellation-policies` — publishes a NEW immutable version for a scope.
 *
 * Never an in-place edit. Publishing closes the current version's interval and opens a new one, so
 * every booking that already has a snapshot keeps its terms (AC-1) and the history of what was ever
 * in force stays readable.
 *
 * `effectiveFrom` is deliberately not a parameter: a caller who could choose it could re-price
 * bookings retroactively. The server's clock decides.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const session = await requireSession(request);
  requireCsrf(request, session.id);
  await requireCancellationPolicyConfigurePermission(session.userId);

  const adminProfileId = await getAdminProfileId(session.userId);
  if (!adminProfileId) throw adminForbiddenError();

  const raw = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw validationError([{ field: 'body', message: 'must be an object' }]);

  if (typeof raw.scope !== 'string' || !POLICY_SCOPES.includes(raw.scope as PolicyScope)) {
    throw validationError([{ field: 'scope', message: `must be one of: ${POLICY_SCOPES.join(', ')}` }]);
  }
  if (raw.effectiveFrom !== undefined) {
    throw validationError([
      { field: 'effectiveFrom', message: 'is not accepted: a policy version takes effect when it is published' },
    ]);
  }

  const policy = await publishCancellationPolicy(session.userId, adminProfileId, {
    scope: raw.scope as PolicyScope,
    scopeId: (raw.scopeId as string | null | undefined) ?? null,
    config: raw.config as never,
    note: typeof raw.note === 'string' ? raw.note : undefined,
  });
  return apiSuccess(policy, correlationId, { status: 201 });
});
