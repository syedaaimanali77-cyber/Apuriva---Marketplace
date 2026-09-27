/** Spec 042 §3.12 — locale request/response types. */
export type LocaleDirection = 'ltr' | 'rtl';

export interface LocaleDto {
  code: string;
  label: string;
  nativeLabel: string;
  direction: LocaleDirection;
}

/** `GET /api/v1/locales` (L1). `locales` lists only AVAILABLE locales, in config order. */
export interface LocalesDto {
  locales: LocaleDto[];
  resolvedLocale: string;
  platformCurrencyCode: string;
}

/** `PATCH /api/v1/users/me/locale` (L2). `null` clears the saved preference. */
export interface UpdateUserLocaleRequest {
  locale: string | null;
}

export interface UserLocaleDto {
  locale: string | null;
  resolvedLocale: string;
  direction: LocaleDirection;
}
