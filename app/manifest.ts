import type { MetadataRoute } from 'next';
import { branding } from '@/lib/config/branding';
import { resolveToken } from '@/lib/pwa/design-tokens';

/**
 * Spec 044 §3.6 (AC-1) — the web app manifest, served at `/manifest.webmanifest`.
 *
 * The three icons are design-supplied artwork (spec 044 DEP-2), delivered to `public/icons/`. This spec
 * does not generate or crop a logo: until those files exist the manifest names them but the app is not
 * installable, and AC-1 stays open.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: branding.appName,
    short_name: branding.appName,
    description: branding.tagline,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: resolveToken('--teal-600'),
    background_color: resolveToken('--surface-page'),
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
