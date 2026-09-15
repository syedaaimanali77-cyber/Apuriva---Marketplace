import { NextRequest, NextResponse } from 'next/server';
import { runRefundReconcileSweep } from '@/lib/refunds';

export const dynamic = 'force-dynamic';

/**
 * Spec 022 §9 "Cron" (AC-7) — Vercel Cron, scheduled `* * * * *` in vercel.json. The same mechanism
 * and bearer-secret check as `/cron/payment-sweep` and `/cron/offer-expiry-sweep`: no new scheduler.
 *
 * Resolves refunds whose provider outcome was ambiguous. Everything it does is a
 * `getRefundStatus` READ — it never issues a second `provider.refund()` — so running it repeatedly,
 * including two overlapping invocations, cannot refund twice. Idempotent and retry-safe: the next
 * minute's run is the retry.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const result = await runRefundReconcileSweep();
  return NextResponse.json({ status: 'ok', ...result });
}
