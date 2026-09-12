/**
 * Spec 015 §5 — the shared client-side fetch helpers for the three request screens. Same
 * CSRF-cookie-echo + `ApiResponse` unwrapping pattern as `app/account/addresses/page.tsx` and
 * `app/search/page.tsx`; extracted here only so the three screens don't each restate it.
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  errors?: { field: string; message: string }[];
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  page?: { limit: number; offset: number; total: number; nextOffset: number | null };
  error?: ApiErrorBody;
}

/** The CSRF cookie (spec 005 §3) is deliberately not httpOnly so the client can echo it. */
function readCsrfCookie(): string {
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

export function mutateHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie(), ...extra };
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (res.status === 204) return { ok: true };
  const json = await res.json().catch(() => ({}));
  return res.ok
    ? { ok: true, data: json.data as T, page: json.page }
    : { ok: false, error: json as ApiErrorBody };
}

/**
 * §5 Error state: turns the API's `errors[]` into a per-field lookup so each control shows its own
 * message. `errors[].field` is the `ServiceField.key` for a service-specific field, so the form's
 * controls are keyed the same way and the mapping needs no translation table.
 */
export function fieldErrorMap(error: ApiErrorBody | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of error?.errors ?? []) {
    if (!(entry.field in map)) map[entry.field] = entry.message;
  }
  return map;
}
