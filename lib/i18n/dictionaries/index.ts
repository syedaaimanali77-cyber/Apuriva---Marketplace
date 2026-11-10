/** Spec 042 §3.5 — every locale's dictionary, keyed by `SUPPORTED_LOCALES` code. Server-side lookups only. */
import type { Locale } from '../config';
import { en, type Dictionary } from './en';
import { ur } from './ur';

export const DICTIONARIES: Readonly<Record<Locale, Dictionary>> = { en, ur };

export function dictionaryFor(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}
