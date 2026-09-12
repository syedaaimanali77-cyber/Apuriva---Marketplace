'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, Icon, Skeleton } from '@/components';
import { branding } from '@/lib/config/branding';
import type { ActiveMode } from '@/lib/types/users';
import { useAccountUser } from './_components/useAccountUser';
import { ModeIndicator } from './_components/ModeIndicator';
import styles from './account.module.css';

const MODE_COPY: Record<ActiveMode, { title: string; description: string; icon: string }> = {
  customer: {
    title: 'Customer Mode',
    description: "You're discovering, requesting and booking local services.",
    icon: 'user',
  },
  provider: {
    title: 'Service Provider Mode',
    description: "You're operating as a service provider — responding to requests and managing your work.",
    icon: 'briefcase',
  },
};

interface SettingsDestination {
  id: string;
  title: string;
  description: string;
  icon: string;
  /** Absent for a destination no page exists for yet — rendered as a non-interactive row. */
  href?: string;
}

// Profile and Preferences have no page yet (no route, no spec); they're listed honestly as
// "Coming soon" rows rather than links that would 404.
const SETTINGS_DESTINATIONS: SettingsDestination[] = [
  { id: 'profile', title: 'Profile', description: 'Personal details for your account', icon: 'user' },
  { id: 'preferences', title: 'Preferences', description: 'How your account behaves and what you see', icon: 'settings' },
  {
    id: 'addresses',
    title: 'Addresses',
    description: 'Saved places for faster requests and bookings',
    icon: 'map-pin',
    href: '/account/addresses',
  },
];

// Exactly the sections app/account/privacy-security/page.tsx already renders — nothing invented.
const SECURITY_FEATURES = ['Active sessions', 'Two-factor authentication', 'Data export', 'Account deletion'];

/**
 * Spec 014 §2 AC-4/AC-5 — the shared "Account" nav destination for both customer and provider
 * mode. Spec 006 owns the identity/active-mode model this page surfaces (via `useAccountUser`,
 * shared with the header's `AccountMenu` — no second mode system, no duplicated switch logic).
 * A signed-out visitor gets a clear Login/Create account entry point here instead of a page that
 * silently assumes an authenticated session. Logout calls spec 005's existing `POST /auth/logout`
 * — until this page, no UI surfaced that endpoint at all. Profile/payment-method content itself is
 * out of this spec's scope; the settings already built by earlier specs are linked from here.
 *
 * Presentation only: every action below calls the same `useAccountUser` mutation as before. `/users/me`
 * carries no name or email, so the profile header shows the account's mode and role — never a
 * placeholder identity.
 */
export default function AccountPage() {
  const { status, user, pending, error, announcement, switchMode, becomeProvider, logout } = useAccountUser();
  // Button isn't built with forwardRef — reached via this wrapping span, the same way AccountMenu
  // reaches its IconButton trigger.
  const switchWrapRef = useRef<HTMLDivElement>(null);

  if (status === 'loading') {
    return (
      <main className={styles.page} aria-busy="true">
        <div className={styles.profile}>
          <Skeleton width={64} height={64} radius="var(--radius-circle)" />
          <Skeleton lines={2} height={18} style={{ flex: 1, maxWidth: 320 }} />
        </div>
        <Skeleton height={176} radius="var(--radius-lg)" />
        <Skeleton height={220} radius="var(--radius-lg)" />
      </main>
    );
  }

  if (status === 'anonymous') {
    return (
      <main className={`${styles.page} ${styles.guestPage}`}>
        <section className={styles.guestPanel} aria-labelledby="guest-heading">
          <span className={styles.guestMark}>
            <Icon name="user" size="lg" />
          </span>
          <div className={styles.guestCopy}>
            <h1 id="guest-heading" className={styles.guestTitle}>
              Welcome to {branding.appName}
            </h1>
            <p className={styles.guestDescription}>Sign in to manage your account, requests, bookings and preferences.</p>
          </div>

          <div className={styles.guestActions}>
            <Link href="/login" className={`${styles.linkButton} ${styles.linkButtonPrimary}`}>
              Log in
            </Link>
            <Link href="/register" className={`${styles.linkButton} ${styles.linkButtonSecondary}`}>
              Create an account
            </Link>
          </div>

          <ul className={styles.guestBenefits}>
            <li>
              <Icon name="check" size="sm" />
              Post requests and compare offers from local providers
            </li>
            <li>
              <Icon name="check" size="sm" />
              Book services and keep track of your bookings
            </li>
            <li>
              <Icon name="check" size="sm" />
              Save addresses and control your privacy and security
            </li>
          </ul>
        </section>
      </main>
    );
  }

  if (!user) return null;

  const mode = MODE_COPY[user.activeMode];
  const otherMode: ActiveMode = user.activeMode === 'customer' ? 'provider' : 'customer';

  async function handleBecomeProvider() {
    // The "Become a Provider" button unmounts on success; move focus to the switch action that
    // replaces it rather than dropping keyboard focus back to <body>.
    if (await becomeProvider()) {
      requestAnimationFrame(() => switchWrapRef.current?.querySelector('button')?.focus());
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.profile}>
        <span className={styles.avatar} aria-hidden="true">
          <Icon name="user" size="lg" />
        </span>
        <div className={styles.profileBody}>
          <h1 className={styles.title}>Your account</h1>
          <p className={styles.subtitle}>Manage how you use the marketplace, your saved places and your security.</p>
          <div className={styles.profileBadges}>
            <ModeIndicator mode={user.activeMode} />
            {user.isAdmin ? (
              <Badge tone="neutral" icon="shield-check">
                Administrator
              </Badge>
            ) : null}
          </div>
        </div>
      </header>

      <section className={styles.modeCard} aria-labelledby="active-mode-heading">
        <div className={styles.modeCurrent} data-mode={user.activeMode}>
          <span className={styles.modeIcon}>
            <Icon name={mode.icon} size="lg" />
          </span>
          <div className={styles.modeCopy}>
            <p className={styles.eyebrow}>Active mode</p>
            <h2 id="active-mode-heading" className={styles.modeTitle}>
              {mode.title}
            </h2>
            <p className={styles.modeDescription}>{mode.description}</p>
          </div>
        </div>

        {user.hasProviderProfile ? (
          <div className={styles.modeSwitch} ref={switchWrapRef}>
            <p className={styles.modeSwitchHint}>
              {otherMode === 'provider'
                ? 'Ready to take on work? Switch to manage requests as a provider.'
                : 'Need a service yourself? Switch back to book as a customer.'}
            </p>
            <Button
              variant="primary"
              iconRight="arrow-right"
              loading={pending}
              onClick={() => switchMode(otherMode)}
            >
              Switch to {MODE_COPY[otherMode].title}
            </Button>
          </div>
        ) : null}
      </section>

      {!user.hasProviderProfile ? (
        <section className={styles.opportunity} aria-labelledby="become-provider-heading">
          <span className={styles.opportunityIcon}>
            <Icon name="briefcase" size="lg" />
          </span>
          <div className={styles.opportunityCopy}>
            <p className={`${styles.eyebrow} ${styles.eyebrowAccent}`}>Earn with your skills</p>
            <h2 id="become-provider-heading" className={styles.opportunityTitle}>
              Become a Service Provider
            </h2>
            <p className={styles.opportunityDescription}>
              Set up a provider profile to start offering your services. You&apos;ll stay in Customer Mode until you choose
              to switch.
            </p>
          </div>
          <Button variant="primary" loading={pending} onClick={handleBecomeProvider} style={{ flexShrink: 0 }}>
            Become a Provider
          </Button>
        </section>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}
      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>

      <nav className={styles.settings} aria-label="Account settings">
        <section className={styles.group} aria-labelledby="settings-heading">
          <h2 id="settings-heading" className={styles.groupTitle}>
            Account settings
          </h2>
          <ul className={styles.list}>
            {SETTINGS_DESTINATIONS.map((item) => {
              const content = (
                <>
                  <span className={styles.rowIcon}>
                    <Icon name={item.icon} size="md" />
                  </span>
                  <span className={styles.rowBody}>
                    <span className={styles.rowTitle}>{item.title}</span>
                    <span className={styles.rowDescription}>{item.description}</span>
                  </span>
                  {item.href ? (
                    <span className={styles.rowChevron}>
                      <Icon name="chevron-right" size="sm" />
                    </span>
                  ) : (
                    <Badge tone="neutral" icon={null} size="sm">
                      Coming soon
                    </Badge>
                  )}
                </>
              );
              return (
                <li key={item.id}>
                  {item.href ? (
                    <Link href={item.href} className={styles.row}>
                      {content}
                    </Link>
                  ) : (
                    <div className={`${styles.row} ${styles.rowUnavailable}`}>{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>

        <section className={styles.group} aria-labelledby="security-heading">
          <h2 id="security-heading" className={styles.groupTitle}>
            Security
          </h2>
          <Link href="/account/privacy-security" className={`${styles.row} ${styles.securityRow}`}>
            <span className={`${styles.rowIcon} ${styles.securityIcon}`}>
              <Icon name="shield-check" size="md" />
            </span>
            <span className={styles.rowBody}>
              <span className={styles.rowTitle}>Privacy & Security</span>
              <span className={styles.rowDescription}>Control where you&apos;re signed in and how your data is handled</span>
              <span className={styles.securityFeatures}>
                {SECURITY_FEATURES.map((feature) => (
                  <span key={feature} className={styles.securityFeature}>
                    {feature}
                  </span>
                ))}
              </span>
            </span>
            <span className={styles.rowChevron}>
              <Icon name="chevron-right" size="sm" />
            </span>
          </Link>
        </section>
      </nav>

      <footer className={styles.signOut}>
        <p className={styles.signOutText}>Signed in on this device</p>
        <Button variant="ghost" iconLeft="log-out" loading={pending} onClick={() => logout()}>
          Log out
        </Button>
      </footer>
    </main>
  );
}
