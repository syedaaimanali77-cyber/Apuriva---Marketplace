/**
 * Spec 042 §3.7 (D-4) — API errors are translated ON THE CLIENT, by stable `code`. The spec 004
 * envelope is unchanged: the server still sends its English `message` and field `errors`.
 *
 *   - a known code (a key under `errors.<CODE>`) → the dictionary text for the locale;
 *   - an unknown code → the server's `message` (then a generic line if there is none).
 *
 * `VALIDATION_ERROR` field messages stay the server's; forms show `common.checkHighlightedFields`
 * above them. No server message is localized. The pure helpers live in `./translator` so a client
 * bundle need not carry every dictionary.
 */
import type { Locale } from './config';
import { translate } from './translate';
import { translateApiErrorWith } from './translator';

export { apiErrorKey, translateApiErrorWith } from './translator';

export function translateApiError(locale: Locale | string, code: string | null | undefined, serverMessage: string | null | undefined): string {
  return translateApiErrorWith((key, params) => translate(locale, key, params), code, serverMessage);
}
