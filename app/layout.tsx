import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { branding } from '@/lib/config/branding';
import { dictionaryFor } from '@/lib/i18n/dictionaries';
import { getRequestLocale } from '@/lib/i18n/server';
import { AppHeader } from './components/AppHeader';
import { NavShell } from './components/NavShell';
import navStyles from './components/nav-shell.module.css';
import { AuthGateResumer } from './_components/AuthGateResumer';
import { LocaleProvider } from './_components/LocaleProvider';
import { OnboardingOverlay } from './_components/OnboardingOverlay';
import { brandFontVariables } from './fonts';
import './styles/apuriva-tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: branding.appName,
  description: branding.tagline,
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
