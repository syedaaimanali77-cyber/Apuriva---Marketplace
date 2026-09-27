'use client';

/**
 * Spec 030 §3 "Urgent / ASAP" (AC-6) — the marketplace-is-not-an-emergency-service disclosure.
 *
 * URGENCY ITSELF IS SPEC 015'S and is not touched: `REQUEST_URGENCIES`, `requests.urgency` and its
 * CHECK all shipped in migration 0011, and this spec adds no column, no enum value and no API
 * behaviour. Nothing blocks, warns or reclassifies a request server-side — master §65 asks for
 * clarity, not gatekeeping. This is one presentational component, owned here, mounted in spec 015's
 * two screens with a single line each (the arrangement spec 029 used for `ReviewSection`).
 *
 * IT NAMES NO EMERGENCY NUMBER (DECIDED-6). Master §65 says only "direct users to appropriate local
 * emergency services", and this repository has no country or locale resolution — spec 042 owns i18n
 * and has not shipped. Printing a wrong number to someone in an emergency is worse than printing
 * none, so the copy uses master §65's own generic wording.
 *
 * ACCESSIBILITY IS PART OF THE REQUIREMENT, not a nicety. AC-6 says "visible, non-fine-print", so
 * this renders as a static block in the normal reading order — never a tooltip, never an
 * `aria-describedby`-only string, and never collapsed behind a disclosure. `role="note"` gives it a
 * landmark a screen reader announces rather than skips.
 */
import { useLocale } from './LocaleProvider';
import styles from './urgency-emergency-notice.module.css';

export interface UrgencyEmergencyNoticeProps {
  /** Adds the surrounding card treatment. Off when the host already renders one. */
  standalone?: boolean;
}

export function UrgencyEmergencyNotice({ standalone = true }: UrgencyEmergencyNoticeProps) {
  const { t } = useLocale();
  return (
    <div className={standalone ? styles.notice : styles.inline} role="note" aria-label={t('shared.urgency.label')}>
      <p className={styles.heading}>{t('shared.urgency.heading')}</p>
      <p className={styles.body}>{t('shared.urgency.body')}</p>
    </div>
  );
}
