import { NextRequest, NextResponse } from 'next/server';
import { runNoShowResponseSweep } from '@/lib/no-show';

export const dynamic = 'force-dynamic';

/**
 * Spec 023 §9 "Cron" — Vercel Cron, scheduled `*\/5 * * * *` in vercel.json. The same mechanism and
 * bearer-secret check as `/cron/payment-sweep` and `/cron/offer-expiry-sweep`; no new scheduling
 * framework is introduced.
 *
 * What it does is deliberately small: move reports whose response window has elapsed from
 * `awaiting_response` to `under_review`, marked `no_response`. It sets NO outcome, moves no money
 * and transitions no booking — silence is not an admission, and only a Trust & Safety admin ever
 * decides a no-show (master spec §51). A five-minute cadence is ample for a window measured in days.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const result = await runNoShowResponseSweep();
  return NextResponse.json({ status: 'ok', ...result });
}
