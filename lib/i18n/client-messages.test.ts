import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from './config';
import { clientMessagesFor, SERVER_ONLY_NAMESPACES } from './client-messages';
import { leafKeys } from './coverage';
import { dictionaryFor } from './dictionaries';
import { en } from './dictionaries/en';
import { lookup } from './translator-core';

/**
 * Spec 042 §3.5 + spec 044 (initial JS payload) — the client receives its dictionaries from the root layout
 * as data, so the client JS bundle carries none. These tests pin that what is passed down still resolves
 * every client-rendered key exactly as the server's `translate()` would (AC-6 fallback included).
 */
const isServerOnly = (key: string) => (SERVER_ONLY_NAMESPACES as readonly string[]).includes(key.split('.')[0]!);
const CLIENT_KEYS = leafKeys(en).filter((key) => !isServerOnly(key));

describe('clientMessagesFor (spec 042 §3.5)', () => {
  it('en: the English dictionary minus the server-only namespaces, and no separate fallback', () => {
    const { messages, fallbackMessages } = clientMessagesFor('en');
    expect(fallbackMessages).toBeUndefined();
    for (const namespace of SERVER_ONLY_NAMESPACES) expect(messages).not.toHaveProperty(namespace);
    for (const key of CLIENT_KEYS) expect(lookup(messages, key), key).toBe(lookup(en, key));
  });

  it.each(SUPPORTED_LOCALES.map((locale) => locale.code))(
    '%s: every client key resolves as the server does — own string, else the English fallback (AC-6)',
    (locale) => {
      const { messages, fallbackMessages } = clientMessagesFor(locale);
      const own = dictionaryFor(locale);
      for (const key of CLIENT_KEYS) {
        const expected = lookup(own, key) ?? lookup(en, key);
        expect(lookup(messages, key) ?? lookup(fallbackMessages, key), key).toBe(expected);
      }
    },
  );

  it.each(SUPPORTED_LOCALES.map((locale) => locale.code).filter((code) => code !== 'en'))(
    '%s: the fallback carries only the English entries the locale lacks, never the whole dictionary',
    (locale) => {
      const { fallbackMessages } = clientMessagesFor(locale);
      const own = dictionaryFor(locale);
      const fallbackKeys = fallbackMessages ? leafKeys(fallbackMessages) : [];
      expect(fallbackKeys.sort()).toEqual(CLIENT_KEYS.filter((key) => lookup(own, key) === undefined).sort());
    },
  );
});

const ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).split(sep).join('/');
const CLIENT_FILES = ['app', 'components']
  .flatMap((dir) => sourceFiles(join(ROOT, dir)))
  .filter((file) => /^\s*['"]use client['"]/.test(readFileSync(file, 'utf8')));

/** Value (non-type) import declarations: `[module, specifiers]`. */
function valueImports(source: string): [string, string][] {
  const out: [string, string][] = [];
  for (const match of source.matchAll(/^import\s+(?!type\s)([^;]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
    const clause = match[1]!;
    const braces = clause.match(/^\{([\s\S]*)\}$/);
    // `import { type A, type B } from …` is erased entirely, like `import type`.
    if (braces && braces[1]!.split(',').every((part) => part.trim() === '' || part.trim().startsWith('type '))) continue;
    out.push([match[2]!, clause]);
  }
  return out;
}

describe('client bundle boundary (spec 042 §3.5, spec 044 initial JS)', () => {
  it('no client component renders a server-only namespace (they are not sent to the client)', () => {
    const offenders = CLIENT_FILES.filter((file) =>
      SERVER_ONLY_NAMESPACES.some((namespace) => new RegExp(`['"\`]${namespace}\\.`).test(readFileSync(file, 'utf8'))),
    ).map(rel);
    expect(offenders).toEqual([]);
  });

  it('client components import no dictionary-bundling i18n module (only the core, config and format)', () => {
    const BUNDLES_A_DICTIONARY = /lib\/i18n\/(dictionaries(\/(en|ur|index))?|translator|translate|errors|coverage|client-messages)$/;
    const offenders = CLIENT_FILES.flatMap((file) =>
      valueImports(readFileSync(file, 'utf8'))
        .filter(([module]) => BUNDLES_A_DICTIONARY.test(module))
        .map(([module]) => `${rel(file)} => ${module}`),
    );
    expect(offenders).toEqual([]);
  });
});
