import { afterEach, describe, expect, it, vi } from 'vitest';
import { absoluteUrl, parseSiteUrl, siteUrl, SiteUrlConfigurationError } from './site-url';

describe('SITE_URL (spec 044 §3.9)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts an https origin in production and an http origin elsewhere', () => {
    expect(parseSiteUrl('https://apuriva.example', 'production').href).toBe('https://apuriva.example/');
    expect(parseSiteUrl('http://localhost:3000', 'development').href).toBe('http://localhost:3000/');
    expect(parseSiteUrl('http://staging.internal', 'development').href).toBe('http://staging.internal/');
    expect(parseSiteUrl('  https://apuriva.example/  ', 'test').origin).toBe('https://apuriva.example');
  });

  it('is a configuration error when missing, relative, not http(s), or http in production', () => {
    for (const [raw, env] of [
      [undefined, 'production'],
      ['', 'development'],
      ['apuriva.example', 'development'],
      ['ftp://apuriva.example', 'development'],
      ['http://apuriva.example', 'production'],
      ['http://localhost.apuriva.example', 'production'],
    ] as const) {
      expect(() => parseSiteUrl(raw, env), `${raw} (${env})`).toThrow(SiteUrlConfigurationError);
    }
  });

  it('in production, plain http is accepted only for a local (loopback) origin — a production build served locally', () => {
    for (const raw of ['http://localhost:3100', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(parseSiteUrl(raw, 'production').protocol, raw).toBe('http:');
    }
  });

  it('must be a bare origin: no path, query, fragment or credentials', () => {
    for (const raw of ['https://apuriva.example/app', 'https://apuriva.example/?a=1', 'https://apuriva.example/#x', 'https://u:p@apuriva.example']) {
      expect(() => parseSiteUrl(raw, 'production'), raw).toThrow(SiteUrlConfigurationError);
    }
  });

  it('reads SITE_URL from the environment on every call', () => {
    vi.stubEnv('SITE_URL', 'https://one.example');
    expect(siteUrl().origin).toBe('https://one.example');
    vi.stubEnv('SITE_URL', 'https://two.example');
    expect(siteUrl().origin).toBe('https://two.example');
  });

  it('builds absolute URLs from SITE_URL and a path, dropping any query or fragment (never the request host)', () => {
    const base = new URL('https://apuriva.example');
    expect(absoluteUrl('/explore/abc', base)).toBe('https://apuriva.example/explore/abc');
    expect(absoluteUrl('explore', base)).toBe('https://apuriva.example/explore');
    expect(absoluteUrl('/search?q=cleaning#top', base)).toBe('https://apuriva.example/search');
    expect(absoluteUrl('/', base)).toBe('https://apuriva.example/');
    vi.stubEnv('SITE_URL', 'https://env.example');
    expect(absoluteUrl('/sitemap.xml')).toBe('https://env.example/sitemap.xml');
  });
});
