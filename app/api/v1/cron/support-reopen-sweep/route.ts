import { NextRequest, NextResponse } from 'next/server';
import { runSupportReopenSweep } from '@/lib/support';

export const dynamic = 'force-dynamic';

/**
 * Spec 032 §9 "Cron" — Vercel Cron, the same mechanism and bearer-secret check as
 * `/cron/dispute-appeal-sweep`, `/cron/payment-sweep` and `/cron/payout-sweep`. No new scheduling
 * framework is introduced. Scheduled hourly in `vercel.json`, matching `dispute-appeal-sweep`,
 * whose job — making an un-contested decision final after a multi-day window — is the same shape.
 *
 * WHAT IT DOES IS DELIBERATELY SMALL: close `resolved` tickets whose reopen window has elapsed. It
 * sets no outcome, changes no priority, reassigns nobody and notifies nobody. An un-reopened
 * resolution simply becomes final, which is the only thing that has to happen for `closed` to be
 * reachable at all.
 *
 * THIS IS NOT AN SLA SWEEP, AND THERE ISN'T ONE. §7 puts automated SLA consequences out of scope:
 * a breached ticket is flagged in the admin queue and nothing else ever happens to it.
 *
 * Cron routes are excluded from the OpenAPI contract by `scripts/check-openapi-drift.ts` (spec 001
 * §8 risk #1): they are platform infrastructure with their own auth, not public REST surface.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } },
      { status: 401 },
    );
  }

  const result = await runSupportReopenSweep();
  return NextResponse.json({ status: 'ok', ...result });
}
