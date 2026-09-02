import { IBM_Plex_Mono, Noto_Nastaliq_Urdu, Sora, Source_Sans_3 } from 'next/font/google';

/**
 * Self-hosts the four brand fonts declared by the APURIVA Design System
 * (ui/_ds_manifest.json → brandFonts) and exposes each under the exact CSS custom property
 * name the DS's components/tokens already reference (--font-display, --font-sans, etc.) —
 * see app/styles/apuriva-tokens.css, which deliberately omits these four so next/font stays
 * the single source for them.
 */
const displayFont = Sora({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
const sansFont = Source_Sans_3({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const monoFont = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
  display: 'swap',
});
const urduFont = Noto_Nastaliq_Urdu({ subsets: ['arabic'], variable: '--font-urdu', display: 'swap' });

export const brandFontVariables = [
  displayFont.variable,
  sansFont.variable,
  monoFont.variable,
  urduFont.variable,
].join(' ');
