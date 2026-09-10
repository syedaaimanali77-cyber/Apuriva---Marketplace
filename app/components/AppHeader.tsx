'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { branding } from '@/lib/config/branding';
import apurivaLogo from '@/ui/assets/apuriva-logo-full.jpeg';
import { AccountMenu } from '@/app/account/_components/AccountMenu';

// Login/register carry their own primary brand placement via AuthShell (spec 005 §5) — per the
// single-brand-placement rule in CLAUDE.md, the global header must not duplicate that logo there.
// Exported so NavShell (spec 014) hides on the same routes rather than redefining this list.
export const HEADERLESS_ROUTES = ['/login', '/register'];

/**
 * Global top bar — every other page gets this, so it intentionally carries no tagline (that's
 * Home-page-only content, see app/page.tsx).
 *
 * ui/assets/apuriva-logo-full.jpeg is a single square (1254x1254) lockup with the mark, the
 * "APURIVA" wordmark, and the tagline stacked vertically (mark: rows 145-793, wordmark:
 * 834-990, tagline: 1030-1080). There's no separate mark/wordmark-only asset in ui/, so the
 * header shows a cropped view of the same file: a container shorter than it is wide, with
 * object-fit "cover" + object-position "top", uniformly scales the (still-square) source to
 * fill the width and clips only the bottom overflow — landing past the wordmark (990px) but
 * before the tagline starts (1030px). The mark and wordmark render at their true proportions,
 * never stretched.
 */
export function AppHeader() {
  const pathname = usePathname();
  if (HEADERLESS_ROUTES.includes(pathname)) {
    return null;
  }
  return (
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 'var(--z-nav)',
        height: 'var(--nav-top-h)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 var(--space-6)',
        background: 'var(--surface-nav)',
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <Link href="/" aria-label={`${branding.appName} home`} style={{ display: 'inline-flex' }}>
        <div style={{ position: 'relative', width: 50, height: 40, overflow: 'hidden' }}>
          <Image
            src={apurivaLogo}
            alt={branding.appName}
            fill
            sizes="50px"
            style={{ objectFit: 'cover', objectPosition: 'top' }}
          />
        </div>
      </Link>

      {/* Spec 006 §5: mode switch is reachable via account menu, available globally. */}
      <AccountMenu />
    </header>
  );
}
