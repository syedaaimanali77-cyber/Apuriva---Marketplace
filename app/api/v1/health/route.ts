import { NextResponse } from 'next/server';
import packageJson from '@/package.json';
import { getPool } from '@/lib/db';
import { logEvent } from '@/lib/observability/log';

export const dynamic = 'force-dynamic';

interface DbStatus {
  connected: boolean;
  latencyMs: number | null;
}

function describeDbError(err: unknown): string {
  // Node's dual-stack (IPv6+IPv4) TCP connect throws an AggregateError with an empty top-level
  // message when the DB is unreachable — the real detail is in .errors[].
  if (err instanceof AggregateError) {
    return err.errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ');
  }
  if (err instanceof Error) return err.message;
  return 'Unknown database error';
}

async function checkDb(): Promise<DbStatus> {
  const startedAt = Date.now();
  try {
    await getPool().query('SELECT 1');
    return { connected: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    // Spec 046 X-1: the detail goes to the platform log, never to this unauthenticated response.
    logEvent('warn', 'health.db_unreachable', { error: describeDbError(err) });
    return { connected: false, latencyMs: null };
  }
}

export async function GET() {
  const db = await checkDb();

  return NextResponse.json({
    status: 'ok',
    version: packageJson.version,
    uptimeSeconds: process.uptime(),
    db,
  });
}
