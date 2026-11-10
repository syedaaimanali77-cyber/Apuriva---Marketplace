/**
 * Spec 042 §3.5 — what the root layout passes to the client `LocaleProvider`: only the resolved locale's
 * dictionary, plus (for a locale other than English) just the English entries that locale lacks, so the
 * AC-6 fallback still works in the browser without shipping the whole English dictionary in the JS bundle.
 * Server code only: it imports every dictionary.
 */
import { DEFAULT_LOCALE, type Locale } from './config';
import { dictionaryFor } from './dictionaries';
import type { Dictionary } from './dictionaries/en';

/**
 * Namespaces only server code renders (server-rendered notifications, metadata, the offline page). They
 * are never sent to the client; `client-messages.test.ts` fails if a client component starts using one.
 */
export const SERVER_ONLY_NAMESPACES = ['notifications', 'seo', 'offline'] as const;

export interface ClientMessages {
  /** The resolved locale's dictionary. */
  messages: Dictionary;
  /** The English text for the keys `messages` lacks (AC-6); absent when there are none. */
  fallbackMessages?: Dictionary;
}

type Tree = Record<string, unknown>;

function withoutServerOnly(dictionary: Dictionary): Dictionary {
  const copy: Tree = { ...dictionary };
  for (const namespace of SERVER_ONLY_NAMESPACES) delete copy[namespace];
  return copy as Dictionary;
}

/** The leaves of `source` that `target` does not have, in `source`'s shape; `undefined` when none. */
function missingEntries(source: Tree, target: Tree | undefined): Tree | undefined {
  let missing: Tree | undefined;
  for (const [name, value] of Object.entries(source)) {
    const own = target?.[name];
    const entry =
      typeof value === 'string'
        ? typeof own === 'string'
          ? undefined
          : value
        : missingEntries(value as Tree, own !== null && typeof own === 'object' ? (own as Tree) : undefined);
    if (entry !== undefined) (missing ??= {})[name] = entry;
  }
  return missing;
}

const cache = new Map<Locale, ClientMessages>();

export function clientMessagesFor(locale: Locale): ClientMessages {
  const cached = cache.get(locale);
  if (cached) return cached;
  const english = withoutServerOnly(dictionaryFor(DEFAULT_LOCALE));
  let result: ClientMessages;
  if (locale === DEFAULT_LOCALE) {
    result = { messages: english };
  } else {
    const messages = withoutServerOnly(dictionaryFor(locale));
    const fallbackMessages = missingEntries(english as Tree, messages as Tree) as Dictionary | undefined;
    result = fallbackMessages ? { messages, fallbackMessages } : { messages };
  }
  cache.set(locale, result);
  return result;
}
