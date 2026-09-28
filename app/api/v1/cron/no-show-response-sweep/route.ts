import { NextResponse } from 'next/server';
import { runNoShowResponseSweep } from '@/lib/no-show';
import { withCronRoute } from '@/lib/cron/route';

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
export const GET = withCronRoute('no-show-response-sweep', async () => {
  const result = await runNoShowResponseSweep();
  return NextResponse.json({ status: 'ok', ...result });
});
