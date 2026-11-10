/**
 * Spec 039 §3.5 (AC-6, D-6) — the request context that makes spec 004's correlation id reachable by
 * the audit writer without threading it through every domain module's signature.
 *
 * Spec 004's `withApiRoute` (`lib/api/handler.ts`, X-1) runs each handler inside
 * `runWithRequestContext`, so any audit write made while that request is being handled can read the
 * request's correlation id. Outside a request (cron routes, scripts, a future system actor) there is
 * no context and `getRequestCorrelationId()` returns `null` — no placeholder id is ever invented.
 *
 * Node runtime only (`node:async_hooks`); every APURIVA route handler runs on Node.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` as the current request context (spec 004 X-1 is the only caller). */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The correlation id of the API request currently being handled, or `null` outside one. */
export function getRequestCorrelationId(): string | null {
  return storage.getStore()?.correlationId ?? null;
}
