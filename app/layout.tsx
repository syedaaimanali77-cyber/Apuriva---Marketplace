import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { branding } from '@/lib/config/branding';
import { AppHeader } from './components/AppHeader';
import { AuthGateResumer } from './_components/AuthGateResumer';
import { OnboardingOverlay } from './_components/OnboardingOverlay';
import { brandFontVariables } from './fonts';
import './styles/apuriva-tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: branding.appName,
  description: branding.tagline,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={brandFontVariables}>
      <body>
        <AppHeader />
        {children}
        {/* Spec 007 AC-1/AC-5: first-run overlay, guest-accessible and app-wide. */}
        <OnboardingOverlay />
        {/* Spec 007 AC-3: completes AuthGate's redirect-and-resume once the guest is authenticated. */}
        <AuthGateResumer />
      </body>
    </html>
  );
}
