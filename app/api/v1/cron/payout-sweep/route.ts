import { NextResponse } from 'next/server';
import { runPayoutSweep } from '@/lib/payouts';
import { withCronRoute } from '@/lib/cron/route';

export const dynamic = 'force-dynamic';

/**
 * Spec 024 §3.6/§3.7/§3.8 — Vercel Cron, scheduled `*\/5 * * * *` in vercel.json. The same mechanism
 * and bearer-secret check as `/cron/payment-sweep` and `/cron/refund-reconcile-sweep`: no new
 * scheduler and no worker process.
 *
 * Reconciles refunds, creates and advances earnings lines, accrues and closes batches, and transfers.
 * Idempotent and retry-safe: every pass is bounded and every item re-checks its predicate under lock.
 */
export const GET = withCronRoute('payout-sweep', async () => {
  const result = await runPayoutSweep();
  return NextResponse.json({ status: 'ok', ...result });
});
