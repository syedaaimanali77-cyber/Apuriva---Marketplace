import { NextRequest, NextResponse } from 'next/server';
import { runPayoutReconcileSweep } from '@/lib/payouts';

export const dynamic = 'force-dynamic';

/**
 * Spec 024 §3.8 (AC-7) — Vercel Cron, scheduled `* * * * *` in vercel.json, matching
 * `/cron/refund-reconcile-sweep`.
 *
 * Resolves payouts whose rail outcome was ambiguous. Everything it does is a READ —
 * `getPayoutStatus` or `getPayoutStatusByIdempotencyKey` — so overlapping invocations can never pay
 * twice. Unresolved payouts are escalated to Finance, never auto-failed and never re-issued.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const result = await runPayoutReconcileSweep();
  return NextResponse.json({ status: 'ok', ...result });
}
