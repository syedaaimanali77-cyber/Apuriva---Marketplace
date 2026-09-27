'use client';

import { useRef } from 'react';
import Link from 'next/link';
import { Alert, Badge, Button, DirectionalIcon, ErrorState, Icon, Skeleton } from '@/components';
import { LocaleSwitcher } from '@/app/_components/LocaleSwitcher';
import { useLocale } from '@/app/_components/LocaleProvider';
import { branding } from '@/lib/config/branding';
import type { MessageKey } from '@/lib/i18n/dictionaries/en';
import type { ActiveMode } from '@/lib/types/users';
import { useAccountUser } from './_components/useAccountUser';
import { ModeIndicator } from './_components/ModeIndicator';
import styles from './account.module.css';

const MODE_COPY: Record<ActiveMode, { title: MessageKey; description: MessageKey; icon: string }> = {
  customer: { title: 'account.mode.customer.title', description: 'account.mode.customer.description', icon: 'user' },
  provider: { title: 'account.mode.provider.title', description: 'account.mode.provider.description', icon: 'briefcase' },
};

interface SettingsDestination {
  id: string;
  title: MessageKey;
  description: MessageKey;
  icon: string;
  /** Absent for a destination no page exists for yet — rendered as a non-interactive row. */
  href?: string;
}

// Profile and Preferences have no page yet (no route, no spec); they're listed honestly as
// "Coming soon" rows rather than links that would 404.
const SETTINGS_DESTINATIONS: SettingsDestination[] = [
  { id: 'profile', title: 'account.destinations.profile.title', description: 'account.destinations.profile.description', icon: 'user' },
  {
    id: 'preferences',
    title: 'account.destinations.preferences.title',
    description: 'account.destinations.preferences.description',
    icon: 'settings',
  },
  {
    id: 'addresses',
    title: 'account.destinations.addresses.title',
    description: 'account.destinations.addresses.description',
    icon: 'map-pin',
    href: '/account/addresses',
  },
  // Spec 026 §5 — the notification centre and preferences entry point (no header bell; see spec §7).
  {
    id: 'notifications',
    title: 'account.destinations.notifications.title',
    description: 'account.destinations.notifications.description',
    icon: 'bell',
    href: '/account/notifications',
  },
];

// Exactly the sections app/account/privacy-security/page.tsx already renders — nothing invented.
const SECURITY_FEATURES: MessageKey[] = [
  'account.security.sessions',
  'account.security.twoFactor',
  'account.security.export',
  'account.security.deletion',
];

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
  const { status, user, pending, error, announcement, switchMode, becomeProvider, logout, retry } = useAccountUser();
  const { t } = useLocale();
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

  // The account could not be REACHED (not an HTTP answer): an error with retry, never the guest screen.
  if (status === 'unavailable') {
    return (
      <main className={styles.page}>
        <ErrorState description={t('account.unreachable')} onRetry={retry} />
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
              {t('account.guest.welcome', { appName: branding.appName })}
            </h1>
            <p className={styles.guestDescription}>{t('account.guest.description')}</p>
          </div>

          <div className={styles.guestActions}>
            <Link href="/login" className={`${styles.linkButton} ${styles.linkButtonPrimary}`}>
              {t('account.guest.logIn')}
            </Link>
            <Link href="/register" className={`${styles.linkButton} ${styles.linkButtonSecondary}`}>
              {t('account.guest.register')}
            </Link>
          </div>

          <ul className={styles.guestBenefits}>
            <li>
              <Icon name="check" size="sm" />
              {t('account.guest.benefitRequests')}
            </li>
            <li>
              <Icon name="check" size="sm" />
              {t('account.guest.benefitBookings')}
            </li>
            <li>
              <Icon name="check" size="sm" />
              {t('account.guest.benefitPrivacy')}
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
          <h1 className={styles.title}>{t('account.title')}</h1>
          <p className={styles.subtitle}>{t('account.subtitle')}</p>
          <div className={styles.profileBadges}>
            <ModeIndicator mode={user.activeMode} />
            {user.isAdmin ? (
              <Badge tone="neutral" icon="shield-check">
                {t('account.administrator')}
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
            <p className={styles.eyebrow}>{t('account.activeMode')}</p>
            <h2 id="active-mode-heading" className={styles.modeTitle}>
              {t(mode.title)}
            </h2>
            <p className={styles.modeDescription}>{t(mode.description)}</p>
          </div>
        </div>

        {user.hasProviderProfile ? (
          <div className={styles.modeSwitch} ref={switchWrapRef}>
            <p className={styles.modeSwitchHint}>
              {otherMode === 'provider' ? t('account.toProvider') : t('account.toCustomer')}
            </p>
            <Button variant="primary" loading={pending} onClick={() => switchMode(otherMode)}>
              {t('account.switchTo', { mode: t(MODE_COPY[otherMode].title) })}
              {/* Spec 042 §5.2: a directional glyph, so it mirrors right-to-left (the DS `iconRight` cannot). */}
              {pending ? null : <DirectionalIcon name="arrow-right" size="sm" />}
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
            <p className={`${styles.eyebrow} ${styles.eyebrowAccent}`}>{t('account.earn')}</p>
            <h2 id="become-provider-heading" className={styles.opportunityTitle}>
              {t('account.becomeTitle')}
            </h2>
            <p className={styles.opportunityDescription}>{t('account.becomeDescription')}</p>
          </div>
          <Button variant="primary" loading={pending} onClick={handleBecomeProvider} style={{ flexShrink: 0 }}>
            {t('account.becomeButton')}
          </Button>
        </section>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}
      <span role="status" aria-live="polite" className={styles.visuallyHidden}>
        {announcement}
      </span>

      {/* Spec 042 §5.2: the signed-in language switcher (persists `users.locale`). Renders nothing while only
          one locale is available, i.e. while `urdu-locale` is off. */}
      <LocaleSwitcher mode="account" />

      <nav className={styles.settings} aria-label={t('account.settingsNav')}>
        <section className={styles.group} aria-labelledby="settings-heading">
          <h2 id="settings-heading" className={styles.groupTitle}>
            {t('account.settingsTitle')}
          </h2>
          <ul className={styles.list}>
            {SETTINGS_DESTINATIONS.map((item) => {
              const content = (
                <>
                  <span className={styles.rowIcon}>
                    <Icon name={item.icon} size="md" />
                  </span>
                  <span className={styles.rowBody}>
                    <span className={styles.rowTitle}>{t(item.title)}</span>
                    <span className={styles.rowDescription}>{t(item.description)}</span>
                  </span>
                  {item.href ? (
                    <span className={styles.rowChevron}>
                      <DirectionalIcon name="chevron-right" size="sm" />
                    </span>
                  ) : (
                    <Badge tone="neutral" icon={null} size="sm">
                      {t('account.comingSoon')}
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
            {t('account.securityTitle')}
          </h2>
          <Link href="/account/privacy-security" className={`${styles.row} ${styles.securityRow}`}>
            <span className={`${styles.rowIcon} ${styles.securityIcon}`}>
              <Icon name="shield-check" size="md" />
            </span>
            <span className={styles.rowBody}>
              <span className={styles.rowTitle}>{t('account.privacySecurity')}</span>
              <span className={styles.rowDescription}>{t('account.privacyDescription')}</span>
              <span className={styles.securityFeatures}>
                {SECURITY_FEATURES.map((feature) => (
                  <span key={feature} className={styles.securityFeature}>
                    {t(feature)}
                  </span>
                ))}
              </span>
            </span>
            <span className={styles.rowChevron}>
              <DirectionalIcon name="chevron-right" size="sm" />
            </span>
          </Link>
        </section>
      </nav>

      <footer className={styles.signOut}>
        <p className={styles.signOutText}>{t('account.signedIn')}</p>
        <Button variant="ghost" iconLeft="log-out" loading={pending} onClick={() => logout()}>
          {t('account.logOut')}
        </Button>
      </footer>
    </main>
  );
}
