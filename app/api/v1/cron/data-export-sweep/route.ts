import { NextRequest, NextResponse } from 'next/server';
import { runExportSweep } from '@/lib/privacy/export';

export const dynamic = 'force-dynamic';

/**
 * Spec 008 §4/B — scheduled job (Vercel Cron, per spec 001 §8 risk #1, same mechanism/pattern as
 * app/api/v1/cron/sample) that actually generates a pending/processing data export. Server-side,
 * asynchronous, idempotent, retry-safe, safe to pause/resume (lib/privacy/export.ts
 * `runExportSweep`) — never depends on the requesting browser staying open.
 */
export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return NextResponse.json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or missing cron secret' } }, { status: 401 });
  }

  const { processed } = await runExportSweep();
  return NextResponse.json({ status: 'ok', processed });
}
