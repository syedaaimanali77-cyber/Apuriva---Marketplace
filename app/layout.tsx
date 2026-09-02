import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { branding } from '@/lib/config/branding';
import { AppHeader } from './components/AppHeader';
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
      </body>
    </html>
  );
}
