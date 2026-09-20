import { NextRequest, NextResponse } from 'next/server';
import { runDisputeAppealSweep } from '@/lib/disputes';

export const dynamic = 'force-dynamic';

/**
 * Spec 031 §9 "Cron" — Vercel Cron, the same mechanism and bearer-secret check as
 * `/cron/payment-sweep`, `/cron/no-show-response-sweep` and `/cron/payout-sweep`. No new scheduling
 * framework is introduced.
 *
 * ADDED DURING THE PROMPT-1 REVIEW (DECIDED-11). AC-7 needs a mover for the appeal deadline, and
 * every other deadline in this repository has a sweep.
 *
 * What it does is deliberately small: close `resolved` disputes whose appeal window has elapsed and
 * whose proposed refund (if any) has reached a terminal state. It sets NO outcome and decides
 * NOTHING — an unappealed decision simply becomes final. Closing is what hands the booking back to
 * `protected` and the payment protection back to `held`, so spec 021's sweep resumes releasing and
 * settling and the provider is paid.
 *
 * A dispute whose refund is still moving is counted and left alone for the next run, because a
 * dispute must never close having promised money nobody has sent.
 *
 * Cron routes are excluded from the OpenAPI contract by `scripts/check-openapi-drift.ts` (spec 001
 * §8 risk #1): they are platform infrastructure with their own auth, not public REST surface.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const result = await runDisputeAppealSweep();
  return NextResponse.json({ status: 'ok', ...result });
}
