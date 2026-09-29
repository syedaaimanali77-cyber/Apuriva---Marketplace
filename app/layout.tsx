import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { branding } from '@/lib/config/branding';
import { dictionaryFor } from '@/lib/i18n/dictionaries';
import { getRequestLocale } from '@/lib/i18n/server';
import { siteUrl } from '@/lib/seo/site-url';
import { AppHeader } from './components/AppHeader';
import { NavShell } from './components/NavShell';
import navStyles from './components/nav-shell.module.css';
import { AuthGateResumer } from './_components/AuthGateResumer';
import { LocaleProvider } from './_components/LocaleProvider';
import { OfflineBanner } from './_components/OfflineBanner';
import { OnboardingOverlay } from './_components/OnboardingOverlay';
import { ServiceWorkerRegistrar } from './_components/ServiceWorkerRegistrar';
import { brandFontVariables } from './fonts';
import './styles/apuriva-tokens.css';
import './globals.css';

/**
 * Spec 002 AC-1: the title and description are the branding config's. Spec 044 §3.9 (X-1): they are also
 * `/`'s own search metadata (the home page is a client component), with its canonical and Open Graph URL
 * resolved against `metadataBase` = `SITE_URL`. Every other segment overrides them: the explore layouts with
 * their own, and each `noindex` layout clears the canonical and Open Graph URL (lib/seo/route-policy.ts).
 *
 * `metadataBase` is a getter so `SITE_URL` is read — and validated — when Next renders a page, not when this
 * module is imported.
 */
export const metadata: Metadata = {
  title: branding.appName,
  description: branding.tagline,
  get metadataBase() {
    return siteUrl();
  },
  alternates: { canonical: '/' },
  openGraph: { title: branding.appName, description: branding.tagline, url: '/', type: 'website', siteName: branding.appName },
  twitter: { card: 'summary_large_image', title: branding.appName, description: branding.tagline },
};

/**
 * Spec 042 §3.4 (X-1, AC-1): `lang`/`dir` are resolved on the SERVER, so the very first paint is already
 * right-to-left for Urdu — the `[lang="ur"]` token block switches the font stack and `[dir='rtl']` turns on
 * `--rtl-flip`. Reading the request's cookies and headers makes every route dynamic (accepted, R-1).
 * Only the resolved locale's dictionary is sent to the client.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale, direction } = await getRequestLocale();
  return (
    <html lang={locale} dir={direction} className={brandFontVariables}>
      <body>
        <LocaleProvider locale={locale} messages={locale === 'en' ? undefined : dictionaryFor(locale)}>
          {/* Spec 044 §3.2/§3.3 (X-1): the service worker (production only) and the app-wide offline notice. */}
          <ServiceWorkerRegistrar />
          <OfflineBanner />
          <AppHeader />
          {/* Spec 014 §5: persistent, persona/mode-aware primary navigation shell. */}
          <NavShell />
          <div className={navStyles.contentArea}>{children}</div>
          {/* Spec 007 AC-1/AC-5: first-run overlay, guest-accessible and app-wide. */}
          <OnboardingOverlay />
          {/* Spec 007 AC-3: completes AuthGate's redirect-and-resume once the guest is authenticated. */}
          <AuthGateResumer />
        </LocaleProvider>
      </body>
    </html>
  );
}
