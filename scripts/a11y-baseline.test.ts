import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  baselineKey,
  compareScope,
  describeComparison,
  isAxeRule,
  mergeCapture,
  raisedKeys,
  ruleOf,
  runMerge,
  scopeOf,
  validateBaseline,
} from './a11y-baseline';

const SCOPE = scopeOf('bookings.detail', false, 'mobile');
const K = (rule: string) => baselineKey('bookings.detail', false, 'mobile', rule);

describe('baseline keys (spec 043 §3.5)', () => {
  it('are "<routeId>[@ur]|<viewport>|<ruleId>"', () => {
    expect(baselineKey('home', true, 'desktop', 'color-contrast')).toBe('home@ur|desktop|color-contrast');
    expect(ruleOf(K('target-size'))).toBe('target-size');
    expect(isAxeRule('color-contrast')).toBe(true);
    expect(isAxeRule('apuriva-focus-visible')).toBe(false);
  });
});

describe('compareScope — the ratchet', () => {
  it('passes when every count equals its baseline', () => {
    expect(compareScope(SCOPE, { [K('color-contrast')]: 3 }, { [K('color-contrast')]: 3 }, isAxeRule)).toEqual({ newViolations: [], stale: [] });
  });

  it('a count above baseline is a NEW violation', () => {
    const c = compareScope(SCOPE, { [K('color-contrast')]: 4 }, { [K('color-contrast')]: 3 }, isAxeRule);
    expect(c.newViolations).toEqual([{ key: K('color-contrast'), current: 4, baseline: 3 }]);
  });

  it('a key missing from the baseline with count > 0 is a NEW violation', () => {
    expect(compareScope(SCOPE, { [K('label')]: 1 }, {}, isAxeRule).newViolations).toEqual([{ key: K('label'), current: 1, baseline: 0 }]);
  });

  it('a count below baseline is STALE, and a fixed key (absent now) must be deleted', () => {
    const c = compareScope(SCOPE, { [K('color-contrast')]: 1 }, { [K('color-contrast')]: 3, [K('label')]: 2 }, isAxeRule);
    expect(c.stale).toEqual([
      { key: K('color-contrast'), current: 1, baseline: 3 },
      { key: K('label'), current: 0, baseline: 2 },
    ]);
    expect(describeComparison(c)).toEqual([
      `baseline stale: lower \`${K('color-contrast')}\` to \`1\``,
      `baseline stale: lower \`${K('label')}\` to \`0\` (delete the key)`,
    ]);
  });

  it('only judges the rules the check owns, and only its own route|viewport scope', () => {
    const baseline = { [K('apuriva-focus-visible')]: 2, [baselineKey('bookings.detail', false, 'desktop', 'label')]: 5, [K('label')]: 1 };
    // The axe scan neither sees the focus key nor the desktop scope.
    expect(compareScope(SCOPE, { [K('label')]: 1 }, baseline, isAxeRule)).toEqual({ newViolations: [], stale: [] });
    // The focus check sees only its own rule.
    expect(compareScope(SCOPE, {}, baseline, (r) => r === 'apuriva-focus-visible').stale).toHaveLength(1);
  });

  it('keeps the @ur scope separate from en', () => {
    const ur = scopeOf('bookings.detail', true, 'mobile');
    expect(compareScope(ur, {}, { [K('label')]: 1 }, isAxeRule)).toEqual({ newViolations: [], stale: [] });
  });
});

describe('validateBaseline', () => {
  it('accepts positive integer counts under well-formed keys', () => {
    expect(validateBaseline({ [K('color-contrast')]: 2, 'home@ur|desktop|apuriva-reduced-motion': 1 })).toEqual([]);
  });
  it('rejects zero, fractional or non-numeric counts and malformed keys', () => {
    expect(validateBaseline({ [K('a')]: 0, [K('b')]: 1.5, [K('c')]: '2', 'bad key': 1 })).toHaveLength(4);
  });
  it('the committed browser/a11y/baseline.json is valid', () => {
    const committed = JSON.parse(readFileSync(join(__dirname, '..', 'browser', 'a11y', 'baseline.json'), 'utf8')) as Record<string, unknown>;
    expect(validateBaseline(committed)).toEqual([]);
  });
});

describe('capture helpers', () => {
  it('raisedKeys lists every key a capture would create or raise', () => {
    expect(raisedKeys({ [K('a')]: 2, [K('b')]: 1, [K('c')]: 1 }, { [K('a')]: 2, [K('b')]: 0 })).toEqual([
      { key: K('b'), current: 1, baseline: 0 },
      { key: K('c'), current: 1, baseline: 0 },
    ]);
  });
  it('mergeCapture replaces exactly the captured scope and rule family, dropping zeros', () => {
    const merged = mergeCapture(
      { [K('label')]: 3, [K('apuriva-focus-visible')]: 1, [baselineKey('home', false, 'mobile', 'label')]: 1 },
      [{ scope: SCOPE, owns: 'axe', counts: { [K('color-contrast')]: 2, [K('region')]: 0 } }],
    );
    expect(merged).toEqual({
      [K('apuriva-focus-visible')]: 1,
      [K('color-contrast')]: 2,
      [baselineKey('home', false, 'mobile', 'label')]: 1,
    });
  });
});

describe('runMerge CLI', () => {
  const files: Record<string, string> = {};
  const io = (env: Record<string, string | undefined> = {}) => {
    const out: string[] = [];
    return { out, readFile: (p: string) => files[p]!, writeFile: (p: string, c: string) => { files[p] = c; }, log: (l: string) => out.push(l), error: (l: string) => out.push(l), env };
  };

  it('merges a capture and prints each raised key', () => {
    files['base.json'] = JSON.stringify({ [K('label')]: 1 });
    files['cap.jsonl'] = `${JSON.stringify({ scope: SCOPE, owns: 'axe', counts: { [K('label')]: 2 } })}\n`;
    const i = io();
    expect(runMerge(['merge', 'cap.jsonl'], i, 'base.json')).toBe(0);
    expect(i.out[0]).toBe(`RAISED ${K('label')}: 1 -> 2`);
    expect(JSON.parse(files['base.json']!)).toEqual({ [K('label')]: 2 });
  });

  it('is refused in CI, and needs a capture file', () => {
    expect(runMerge(['merge', 'cap.jsonl'], io({ CI: 'true' }), 'base.json')).toBe(1);
    expect(runMerge(['merge'], io(), 'base.json')).toBe(2);
  });
});
