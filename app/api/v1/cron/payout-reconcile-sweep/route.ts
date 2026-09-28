import { NextResponse } from 'next/server';
import { runPayoutReconcileSweep } from '@/lib/payouts';
import { withCronRoute } from '@/lib/cron/route';

export const dynamic = 'force-dynamic';

/**
 * Spec 024 §3.8 (AC-7) — Vercel Cron, scheduled `* * * * *` in vercel.json, matching
 * `/cron/refund-reconcile-sweep`.
 *
 * Resolves payouts whose rail outcome was ambiguous. Everything it does is a READ —
 * `getPayoutStatus` or `getPayoutStatusByIdempotencyKey` — so overlapping invocations can never pay
 * twice. Unresolved payouts are escalated to Finance, never auto-failed and never re-issued.
 */
export const GET = withCronRoute('payout-reconcile-sweep', async () => {
  const result = await runPayoutReconcileSweep();
  return NextResponse.json({ status: 'ok', ...result });
});
