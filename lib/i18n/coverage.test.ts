import { describe, expect, it } from 'vitest';
import { coverageReport, leafKeys, missingKeys, unknownKeys } from './coverage';
import { en, type Dictionary } from './dictionaries/en';
import { ur } from './dictionaries/ur';

/** Spec 042 §3.5 / §6 / §9 — the translation coverage checklist. */
describe('translation coverage (spec 042 §9)', () => {
  it('lists every English key missing from ur (the checklist `urdu-locale` waits on)', () => {
    const report = coverageReport('ur');
    expect(report.total).toBe(leafKeys(en).length);
    expect(report.translated + report.missing.length).toBe(report.total);
    // Reported so the checklist is visible in CI output; the flag stays off until this is empty.
    console.log(JSON.stringify({ event: 'i18n.coverage', locale: 'ur', total: report.total, missing: report.missing.length }));
    expect(missingKeys('ur')).toEqual(report.missing);
  });

  it('en has no missing keys against itself', () => {
    expect(missingKeys('en')).toEqual([]);
  });

  it('ur has no unknown keys (runtime check; the `satisfies Dictionary` type already forbids them)', () => {
    expect(unknownKeys('ur')).toEqual([]);
    // Type-level: an unknown key is a compile error.
    // @ts-expect-error — `notAKey` is not an English key.
    const bad: Dictionary = { common: { notAKey: 'x' } };
    expect(leafKeys(bad)).toEqual(['common.notAKey']);
  });

  it('every ur string keeps exactly the placeholders of its English source', () => {
    const placeholders = (s: string) => [...s.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
    const walk = (enNode: Record<string, unknown>, urNode: Record<string, unknown>, prefix: string) => {
      for (const [key, value] of Object.entries(urNode)) {
        const path = `${prefix}${key}`;
        if (typeof value === 'string') expect(placeholders(value), path).toEqual(placeholders(enNode[key] as string));
        else walk(enNode[key] as Record<string, unknown>, value as Record<string, unknown>, `${path}.`);
      }
    };
    walk(en as unknown as Record<string, unknown>, ur as unknown as Record<string, unknown>, '');
  });

  it('no string in either dictionary is empty', () => {
    for (const dictionary of [en, ur] as unknown as Record<string, unknown>[]) {
      const values: string[] = [];
      const collect = (node: Record<string, unknown>) => {
        for (const value of Object.values(node)) {
          if (typeof value === 'string') values.push(value);
          else collect(value as Record<string, unknown>);
        }
      };
      collect(dictionary);
      expect(values.every((v) => v.trim().length > 0)).toBe(true);
    }
  });
});
