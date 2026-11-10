/**
 * Spec 039 §3.6 — the composition-root registration, called from `instrumentation.ts` (X-4).
 *
 * Makes spec 035's audit port durable. Idempotent: registering replaces the sink, never accumulates.
 * Rolling spec 039 back returns the port to spec 035's stdout default.
 */
import { registerMcpAuditSink } from '@/lib/mcp/audit';
import { durableMcpAuditSink } from './mcp-sink';

export function registerAuditIntegration(): void {
  registerMcpAuditSink(durableMcpAuditSink);
}
