import { NextResponse } from 'next/server';
import { runExportSweep } from '@/lib/privacy/export';
import { withCronRoute } from '@/lib/cron/route';

export const dynamic = 'force-dynamic';

/**
 * Spec 008 §4/B — scheduled job (Vercel Cron, per spec 001 §8 risk #1, same mechanism/pattern as
 * app/api/v1/cron/sample) that actually generates a pending/processing data export. Server-side,
 * asynchronous, idempotent, retry-safe, safe to pause/resume (lib/privacy/export.ts
 * `runExportSweep`) — never depends on the requesting browser staying open.
 */
export const GET = withCronRoute('data-export-sweep', async () => {
  const { processed } = await runExportSweep();
  return NextResponse.json({ status: 'ok', processed });
});
