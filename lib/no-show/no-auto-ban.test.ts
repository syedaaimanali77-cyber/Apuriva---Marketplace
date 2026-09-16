import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { subjectRoleForOutcome } from './reliability';

/**
 * Spec 023 AC-6 / master spec §132.11 — repeated verified no-shows affect a reliability SIGNAL, and
 * nothing else. No automatic ban, suspension, restriction or de-ranking, ever.
 *
 * This is the rule most likely to be broken with good intentions ("three strikes and they're out"),
 * so it is asserted at source level as well as behaviourally.
 */
const NO_SHOW_DIR = join(process.cwd(), 'lib', 'no-show');

function sourceFiles(dir: string): Array<{ path: string; source: string }> {
  const results: Array<{ path: string; source: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.includes('.test.') || entry.includes('test-support')) continue;
    results.push({ path: full, source: readFileSync(full, 'utf8') });
  }
  return results;
}

const FILES = sourceFiles(NO_SHOW_DIR);

describe('no automatic ban (spec 023 AC-6, master spec §132.11)', () => {
  it('writes no user, customer or provider lifecycle status anywhere', () => {
    const offenders = FILES.filter(({ source }) =>
      /UPDATE\s+"?(users|provider_profiles|customer_profiles)"?/i.test(source),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  it('calls nothing that suspends, bans or deactivates an account', () => {
    const offenders = FILES.filter(({ source }) => /\b(suspend|ban|deactivate|restrict)[A-Za-z]*\s*\(/.test(source));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  /**
   * A threshold in this domain would BE the automatic ban, whatever it was called. Counting is the
   * consumer's business (spec 017); this spec supplies the count and holds no opinion about when a
   * number becomes too many.
   */
  it('encodes no strike threshold of its own', () => {
    const offenders = FILES.filter(({ source }) =>
      /(MAX_NO_SHOWS|STRIKE|THRESHOLD|>=\s*3\b)/.test(source),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  /** The ranking algorithm is spec 017's. This spec must contain no score arithmetic at all. */
  it('computes no score or weight', () => {
    const offenders = FILES.filter(({ source }) => /\b(score|weight|ranking)\b\s*[:=]/i.test(source));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});

describe('signal attribution (spec 023 AC-6)', () => {
  /** The outcome names the party at fault, so attribution needs no second decision to get wrong. */
  it('attributes a confirmed no-show to the faulted party, never the reporter', () => {
    expect(subjectRoleForOutcome('no_show_confirmed_customer')).toBe('customer');
    expect(subjectRoleForOutcome('no_show_confirmed_provider')).toBe('provider');
  });
});
