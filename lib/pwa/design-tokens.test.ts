import { describe, expect, it } from 'vitest';
import manifest from '@/app/manifest';
import { branding } from '@/lib/config/branding';
import { resolveToken } from './design-tokens';

describe('design tokens for the web app manifest (spec 044 §3.6)', () => {
  it('reads a token value from ui/_ds_manifest.json, following var() aliases', () => {
    expect(resolveToken('--teal-600')).toBe('#0A918C');
    expect(resolveToken('--surface-page')).toBe(resolveToken('--gray-50'));
    expect(resolveToken('--a', [{ name: '--a', value: 'var(--b)' }, { name: '--b', value: 'var(--c)' }, { name: '--c', value: '#123456' }])).toBe('#123456');
  });

  it('refuses an unknown or dangling token rather than inventing a colour', () => {
    expect(() => resolveToken('--no-such-token')).toThrow(/does not resolve/);
    expect(() => resolveToken('--a', [{ name: '--a', value: 'var(--missing)' }])).toThrow(/does not resolve/);
  });
});

describe('app/manifest.ts (spec 044 AC-1)', () => {
  it('is installable metadata: names, start URL, standalone, DS colours and the three design icons', () => {
    const m = manifest();
    expect(m).toMatchObject({
      name: branding.appName,
      short_name: branding.appName,
      description: branding.tagline,
      start_url: '/',
      display: 'standalone',
      theme_color: resolveToken('--teal-600'),
      background_color: resolveToken('--surface-page'),
    });
    expect(m.icons).toEqual([
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });
});
