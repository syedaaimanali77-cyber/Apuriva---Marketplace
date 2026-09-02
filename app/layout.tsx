import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppHeader } from './components/AppHeader';
import { brandFontVariables } from './fonts';
import './styles/apuriva-tokens.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Apuriva',
  description: 'Apuriva services marketplace',
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
