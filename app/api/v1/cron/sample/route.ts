import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Sample scheduled job proving the chosen background-job mechanism (spec 001, §8 risk #1):
 * Vercel Cron invokes this route on a schedule (see vercel.json) instead of a separately
 * deployed, always-on worker process. Later specs (offer expiry, notification dispatch,
 * payout eligibility, ...) add their own routes under app/api/v1/cron/ following this pattern.
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

  const firedAt = new Date().toISOString();
  console.log(`[cron] sample job fired at ${firedAt}`);

  return NextResponse.json({ status: 'ok', firedAt });
}
