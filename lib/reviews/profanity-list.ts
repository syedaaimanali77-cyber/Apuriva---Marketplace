/**
 * Spec 029 §3 "Deterministic MVP flagging" — the profanity wordlist.
 *
 * Kept in its own module so it can be maintained without touching the signal logic, and so
 * `signals.ts` stays a pure function over an injectable list.
 *
 * MATCHING IS WHOLE-WORD, never substring: substring matching is what produces the classic false
 * positives on ordinary words, and a false positive here means a legitimate review is queued for a
 * human who did not need to look at it. Entries are lowercase and unaccented; the matcher folds
 * case and diacritics before comparing, and the caller has already stripped zero-width characters,
 * so simple obfuscation does not slip past.
 *
 * Deliberately short and uncontroversial. Growing it is a product/Trust-and-Safety decision, not an
 * engineering one, and a flag is only ever a queue signal — it never hides anything (AC-4).
 */
export const PROFANITY_WORDS: readonly string[] = [
  'arse',
  'arsehole',
  'asshole',
  'bastard',
  'bitch',
  'bollocks',
  'bullshit',
  'cock',
  'crap',
  'cunt',
  'dickhead',
  'douchebag',
  'fuck',
  'fucker',
  'fucking',
  'jackass',
  'motherfucker',
  'piss',
  'prick',
  'shit',
  'shitty',
  'slut',
  'twat',
  'wanker',
  'whore',
];
