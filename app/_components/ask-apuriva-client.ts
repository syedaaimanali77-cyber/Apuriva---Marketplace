/**
 * Spec 034 §5 — the browser side of `/api/v1/ai/*`, shared by the Ask Apuriva panel and the three
 * account pages. Same CSRF-cookie-echo pattern as app/account/notifications/page.tsx.
 *
 * Nothing here writes to `localStorage`, `sessionStorage` or IndexedDB: a temporary conversation's
 * transcript lives only in component state (spec 034 §3.11, AC-14).
 */
export interface AiApiError {
  code: string;
  message: string;
}

export interface AiApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  page?: { nextOffset: number | null; total?: number };
  error?: AiApiError;
}

function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

export async function readAiResponse<T>(res: Response): Promise<AiApiResult<T>> {
  if (res.status === 204) return { ok: true, status: 204 };
  const json = await res.json().catch(() => ({}));
  return res.ok
    ? { ok: true, status: res.status, data: json.data as T, page: json.page }
    : { ok: false, status: res.status, error: json as AiApiError };
}

export async function aiFetch<T>(url: string, init?: RequestInit): Promise<AiApiResult<T>> {
  try {
    return await readAiResponse<T>(await fetch(url, { credentials: 'same-origin', ...init }));
  } catch {
    return { ok: false, status: 0, error: { code: 'NETWORK_ERROR', message: 'We could not reach the server.' } };
  }
}

/** A state-changing request: CSRF header always, `Idempotency-Key` where the route requires one. */
export function aiMutation(method: 'POST' | 'PATCH' | 'DELETE', body?: unknown, idempotencyKey?: string): RequestInit {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body) };
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Spec 033's degradable codes (§3.9): the assistant is unavailable, never the underlying feature. */
export function isAiUnavailable(error: AiApiError | undefined): boolean {
  return error?.code === 'AI_RATE_LIMITED' || error?.code === 'AI_QUOTA_EXCEEDED' || error?.code === 'AI_PROVIDER_UNAVAILABLE';
}

export function formatAiInstant(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
