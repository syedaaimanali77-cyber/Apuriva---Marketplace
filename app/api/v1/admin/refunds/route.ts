import { withApiRoute } from '@/lib/api/handler';
import { apiPaged, apiSuccess } from '@/lib/api/response';
import { buildPage, parsePageParams } from '@/lib/api/pagination';
import { validationError } from '@/lib/api/errors';
import {
  executeRefundOverride,
  initiateRefundOverride,
  listRefundsForAdmin,
  requireRefundReadPermission,
} from '@/lib/refunds';
import { isRefundReconciliationState, isRefundStatus } from '@/lib/types/refunds';
import { guardAdminRefundRequest, refundIdempotencyKey, withRefundProviderGuard } from '../../refunds/route-guards';

/**
 * Spec 022 §3, `POST /api/v1/admin/refunds` — AC-3, the Finance Admin override.
 *
 * Two shapes, distinguished by whether `adminActionId` is present:
 *
 *   - INITIATE (no `adminActionId`): routes through spec 009's `authorizeAndInitiate` on
 *     `(refunds, override)`, which migration 0018 seeds at risk tier `high`. Answers `202` with the
 *     `adminActionId` awaiting a SECOND, distinct admin. **No refund row is created and no provider
 *     call is made.**
 *   - EXECUTE (`adminActionId` present): runs the refund, but only after spec 009's
 *     `executeApprovedAction` confirms the action was approved. A still-`Pending` action is
 *     `422 APPROVAL_REQUIRED`; a rejected or already-executed one is `409 APPROVAL_NOT_ELIGIBLE`.
 *
 * Self-approval is impossible because spec 009's `decideAction` — not this route — owns the
 * approval decision and refuses an approver who is the initiator.
 */
export const POST = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardAdminRefundRequest(request);
  const idempotencyKey = refundIdempotencyKey(request);
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

  const amountMinorUnits = body.amountMinorUnits;
  const currencyCode = typeof body.currencyCode === 'string' ? body.currencyCode.trim().toUpperCase() : '';
  const errors: { field: string; message: string }[] = [];
  if (typeof amountMinorUnits !== 'number') errors.push({ field: 'amountMinorUnits', message: 'is required' });
  if (currencyCode.length === 0) errors.push({ field: 'currencyCode', message: 'is required' });
  if (errors.length > 0) throw validationError(errors);

  if (typeof body.adminActionId === 'string' && body.adminActionId.length > 0) {
    const refund = await withRefundProviderGuard(() =>
      executeRefundOverride({
        adminUserId: userId,
        adminActionId: body.adminActionId as string,
        amountMinorUnits: amountMinorUnits as number,
        currencyCode,
        idempotencyKey,
      }),
    );
    return apiSuccess(refund, correlationId, { status: 201 });
  }

  const bookingId = typeof body.bookingId === 'string' ? body.bookingId : '';
  const reason = typeof body.reason === 'string' ? body.reason : '';
  if (bookingId.length === 0) throw validationError([{ field: 'bookingId', message: 'is required' }]);

  const result = await withRefundProviderGuard(() =>
    initiateRefundOverride({
      adminUserId: userId,
      bookingId,
      amountMinorUnits: amountMinorUnits as number,
      currencyCode,
      reason,
      idempotencyKey,
    }),
  );

  // Always 202 with the shipped `high` seed: accepted, awaiting a second admin. Nothing has been
  // refunded, no provider call was made, and no refund row exists yet.
  return apiSuccess(result.override, correlationId, { status: 202 });
});

/**
 * `GET /api/v1/admin/refunds` — the Finance Admin listing, paged with spec 004's shared helpers.
 *
 * Gated on `refunds/read` (seeded `low`, so no approval flow). This is the one surface that shows
 * `adminActionId`, because the approval chain is admin data.
 */
export const GET = withApiRoute(async (request, correlationId) => {
  const { userId } = await guardAdminRefundRequest(request, { csrf: false });
  await requireRefundReadPermission(userId);

  const params = new URL(request.url).searchParams;
  const page = parsePageParams(params);

  const statusParam = params.get('status');
  const reconciliationParam = params.get('reconciliationState');
  if (statusParam !== null && !isRefundStatus(statusParam)) {
    throw validationError([{ field: 'status', message: 'is not a valid refund status' }]);
  }
  if (reconciliationParam !== null && !isRefundReconciliationState(reconciliationParam)) {
    throw validationError([{ field: 'reconciliationState', message: 'is not a valid reconciliation state' }]);
  }

  const { items, total } = await listRefundsForAdmin(
    {
      status: isRefundStatus(statusParam) ? statusParam : undefined,
      reconciliationState: isRefundReconciliationState(reconciliationParam) ? reconciliationParam : undefined,
    },
    page,
  );
  return apiPaged(items, buildPage(total, page.limit, page.offset), correlationId);
});
