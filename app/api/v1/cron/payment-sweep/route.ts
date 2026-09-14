import { NextRequest, NextResponse } from 'next/server';
import { runPaymentSweep } from '@/lib/payments';

export const dynamic = 'force-dynamic';

/**
 * Spec 021 §9 "Cron" (AC-5a, AC-5b, AC-5c, AC-9) — Vercel Cron, scheduled `* * * * *` in
 * vercel.json. The same mechanism and bearer-secret check as `/cron/offer-expiry-sweep` and
 * `/cron/data-export-sweep`: no new scheduling framework is introduced.
 *
 * Three passes per invocation — open protection on completed bookings, resolve elapsed or disputed
 * protection, fail expired unpaid `pending` bookings. Idempotent and retry-safe: the next minute's
 * run is the retry, and every pass re-checks its predicate under `FOR UPDATE SKIP LOCKED`.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const result = await runPaymentSweep();
  return NextResponse.json({ status: 'ok', ...result });
}
