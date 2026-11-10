/**
 * Spec 044 §3.9 — `SITE_URL`, the absolute public origin every canonical, Open Graph URL, sitemap entry
 * and `robots.txt` line is built from. Never the request host: a crawler reaching a preview or proxied host
 * still sees the one real origin, and staging (its own `SITE_URL`) never points at production.
 *
 * It must be an absolute origin (no path, query or fragment): `https:` in production, where plain `http:` is
 * accepted only for a local (loopback) origin — a production build served on localhost, as CI's browser jobs
 * do; `http:` or `https:` elsewhere. Anything else is a configuration error, raised when a page's metadata is
 * built.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export class SiteUrlConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SiteUrlConfigurationError';
  }
}

export function parseSiteUrl(raw: string | undefined, nodeEnv: string | undefined): URL {
  const value = raw?.trim();
  if (!value) throw new SiteUrlConfigurationError('SITE_URL is not set (spec 044 §3.9; see .env.example).');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SiteUrlConfigurationError(`SITE_URL is not an absolute URL: "${value}".`);
  }
  const httpAllowed = nodeEnv !== 'production' || LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(httpAllowed && url.protocol === 'http:')) {
    const rule = nodeEnv === 'production' ? 'https: in production (http: only for a local origin)' : 'http: or https:';
    throw new SiteUrlConfigurationError(`SITE_URL must use ${rule}: "${value}".`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new SiteUrlConfigurationError(`SITE_URL must be a bare origin such as https://apuriva.example, not "${value}".`);
  }
  return new URL(url.origin);
}

/** The configured origin, validated on every call (cheap; keeps tests free to change the env). */
export function siteUrl(): URL {
  return parseSiteUrl(process.env.SITE_URL, process.env.NODE_ENV);
}

/** `SITE_URL` + a path, with any query string or fragment dropped (§3.9: no query on a canonical). */
export function absoluteUrl(path: string, base: URL = siteUrl()): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, base);
  return `${url.origin}${url.pathname}`;
}
