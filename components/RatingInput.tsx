'use client';

/**
 * Spec 029 §5 — a keyboard-operable 1–5 star input.
 *
 * WHY THIS EXISTS AT ALL. `ui/components/marketplace/Rating` is DISPLAY-ONLY: it takes a numeric
 * `value` and renders stars. There is no input primitive anywhere in `ui/`, which spec 029 §5
 * records as a genuine design-system gap rather than working around silently. So this is built
 * app-side from the design system's own parts — the `star` icon and the `--rating-star` /
 * `--rating-star-empty` tokens — and exported from `@/components`, exactly the documented precedent
 * `ConfirmDialog`, `PriceDisplay`, `SearchBar` and `AddressForm` already follow. Nothing here forks
 * `Rating`, and no new token is introduced.
 *
 * ACCESSIBILITY IS THE POINT, not a finishing touch. This is a real radiogroup of five radio
 * inputs, so arrow keys move between options, Tab reaches the group once, the browser's own focus
 * ring is preserved, and each option has an accessible name ("2 out of 5"). A div-with-onClick
 * would look identical and be unusable without a mouse.
 */
import { Icon } from '@/ui/components/core/Icon.jsx';
import styles from './rating-input.module.css';

export interface RatingInputProps {
  value: number | null;
  onChange: (value: number) => void;
  /** Rendered as the group's accessible name. */
  label?: string;
  disabled?: boolean;
  name?: string;
}

const STARS = [1, 2, 3, 4, 5] as const;

export function RatingInput({
  value,
  onChange,
  label = 'Your rating',
  disabled = false,
  name = 'rating',
}: RatingInputProps) {
  return (
    <fieldset className={styles.group} disabled={disabled}>
      <legend className={styles.legend}>{label}</legend>
      <div className={styles.stars}>
        {STARS.map((star) => {
          const filled = value !== null && star <= value;
          return (
            <label key={star} className={styles.star} data-filled={filled ? 'true' : 'false'}>
              <input
                type="radio"
                name={name}
                value={star}
                checked={value === star}
                onChange={() => onChange(star)}
                className={styles.radio}
              />
              {/* The label text is the accessible name; it is visually hidden, not removed, so a
                  screen reader announces "3 out of 5" while sighted users see the star. */}
              <span className={styles.srOnly}>{`${star} out of 5`}</span>
              <Icon
                name="star"
                size={28}
                strokeWidth={0}
                color={filled ? 'var(--rating-star)' : 'var(--rating-star-empty)'}
                style={{ fill: filled ? 'var(--rating-star)' : 'var(--rating-star-empty)' }}
              />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
