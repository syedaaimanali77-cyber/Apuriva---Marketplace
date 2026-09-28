import { NextResponse } from 'next/server';
import { sweepDeletions } from '@/lib/privacy/deletion';
import { withCronRoute } from '@/lib/cron/route';

export const dynamic = 'force-dynamic';

/**
 * Spec 008 §4/C — scheduled job (Vercel Cron, same mechanism/pattern as app/api/v1/cron/sample)
 * that anonymizes accounts whose grace period has elapsed. Server-side, asynchronous, idempotent,
 * retry-safe, safe to pause/resume (lib/privacy/deletion.ts `sweepDeletions`) — never depends on
 * client execution.
 */
export const GET = withCronRoute('account-deletion-sweep', async () => {
  const { processed } = await sweepDeletions();
  return NextResponse.json({ status: 'ok', processed });
});
