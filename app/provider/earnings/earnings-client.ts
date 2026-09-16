/**
 * Spec 024 §5 — the small client helpers the earnings and payout-method screens share.
 *
 * Money is formatted here and NEVER computed: every figure arrives as a finished integer from the
 * server (AC-3). The step-up helper uses spec 005's existing `POST /api/v1/auth/step-up`, the same
 * flow `app/account/privacy-security` uses.
 */

export interface ApiErrorBody {
  code: string;
  message: string;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  page?: { total: number; nextOffset: number | null };
  error?: ApiErrorBody;
}

export const EARNINGS_POLL_MS = 10_000;
export const MANAGE_PAYOUT_METHOD_ACTION = 'manage_payout_method';

export function readCsrfCookie(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.split('; ').find((row) => row.startsWith('apuriva_csrf='))?.split('=')[1] ?? '';
}

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, status: res.status, data: json.data as T, page: json.page as ApiResult<T>['page'] };
  return { ok: false, status: res.status, error: json as unknown as ApiErrorBody };
}

/** Requests a single-use, action-bound step-up token immediately before a mutation (§3.9). */
export async function requestStepUpToken(): Promise<string | null> {
  const result = await apiFetch<{ stepUpToken: string }>('/api/v1/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': readCsrfCookie() },
    body: JSON.stringify({ action: MANAGE_PAYOUT_METHOD_ACTION }),
  });
  return result.ok ? (result.data?.stepUpToken ?? null) : null;
}

export function formatMoney(amountMinorUnits: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amountMinorUnits / 100);
  } catch {
    return `${currencyCode} ${(amountMinorUnits / 100).toFixed(2)}`;
  }
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export const PAYOUT_STATUS_LABELS: Record<string, string> = {
  pending: 'Accruing',
  eligible: 'Ready to send',
  processing: 'Payout in progress',
  paid: 'Paid',
  failed: 'Did not complete',
};

export const LINE_STATE_LABELS: Record<string, string> = {
  pending: 'Pending',
  eligible: 'Upcoming',
  paid: 'Paid',
};
