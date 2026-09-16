import { NextRequest, NextResponse } from 'next/server';
import { runPayoutSweep } from '@/lib/payouts';

export const dynamic = 'force-dynamic';

/**
 * Spec 024 §3.6/§3.7/§3.8 — Vercel Cron, scheduled `*\/5 * * * *` in vercel.json. The same mechanism
 * and bearer-secret check as `/cron/payment-sweep` and `/cron/refund-reconcile-sweep`: no new
 * scheduler and no worker process.
 *
 * Reconciles refunds, creates and advances earnings lines, accrues and closes batches, and transfers.
 * Idempotent and retry-safe: every pass is bounded and every item re-checks its predicate under lock.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const result = await runPayoutSweep();
  return NextResponse.json({ status: 'ok', ...result });
}
