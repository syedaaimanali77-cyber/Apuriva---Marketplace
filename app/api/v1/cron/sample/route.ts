import { NextResponse } from 'next/server';
import { withCronRoute } from '@/lib/cron/route';

export const dynamic = 'force-dynamic';

/**
 * Sample scheduled job proving the chosen background-job mechanism (spec 001, §8 risk #1):
 * Vercel Cron invokes this route on a schedule (see vercel.json) instead of a separately
 * deployed, always-on worker process. Later specs (offer expiry, notification dispatch,
 * payout eligibility, ...) add their own routes under app/api/v1/cron/ following this pattern.
 */
export const GET = withCronRoute('sample', async () => {
  const firedAt = new Date().toISOString();
  console.log(`[cron] sample job fired at ${firedAt}`);

  return NextResponse.json({ status: 'ok', firedAt });
});
