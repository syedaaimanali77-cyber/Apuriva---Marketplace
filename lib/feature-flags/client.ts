/**
 * Spec 041 §3.6 F3 — the browser's only way to read a flag. Client-safe: imports nothing server-side.
 *
 * Returns the flag's value from `GET /api/v1/feature-flags/effective`, or `fallback` when the request
 * fails, the response is not OK, or the flag is absent — a UI never breaks because flags are
 * unreachable; it shows the flag's documented default instead.
 */
export async function fetchClientFlag(key: string, fallback: boolean): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/feature-flags/effective', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return fallback;
    const json = (await res.json()) as { data?: { flags?: Record<string, unknown> } };
    const value = json.data?.flags?.[key];
    return typeof value === 'boolean' ? value : fallback;
  } catch {
    return fallback;
  }
}
