import { NextRequest, NextResponse } from 'next/server';
import { sweepDeletions } from '@/lib/privacy/deletion';

export const dynamic = 'force-dynamic';

/**
 * Spec 008 §4/C — scheduled job (Vercel Cron, same mechanism/pattern as app/api/v1/cron/sample)
 * that anonymizes accounts whose grace period has elapsed. Server-side, asynchronous, idempotent,
 * retry-safe, safe to pause/resume (lib/privacy/deletion.ts `sweepDeletions`) — never depends on
 * client execution.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const { processed } = await sweepDeletions();
  return NextResponse.json({ status: 'ok', processed });
}
