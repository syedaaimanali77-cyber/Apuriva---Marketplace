import { describe, expect, it } from 'vitest';
import { compareCanonical, orderCanonically, parseOfferIdsParam, selectForComparison, topMatchOfferId } from './comparison';

/** Spec 019 AC-10 — the pure selection/ordering rules behind the comparison contract. */
const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

const candidate = (offerId: string, rank: number | null, sentAtMs: number) => ({ offerId, rank, sentAt: new Date(sentAtMs) });

describe('comparison selection (spec 019 AC-10)', () => {
  it('more than 3 offerIds is COMPARISON_LIMIT_EXCEEDED', () => {
    expect(() => parseOfferIdsParam(UUIDS.join(','))).toThrowError(
      expect.objectContaining({ code: 'COMPARISON_LIMIT_EXCEEDED', status: 422 }),
    );
  });

  it('fewer than 2, duplicates or malformed ids are VALIDATION_ERROR', () => {
    const validation = expect.objectContaining({ code: 'VALIDATION_ERROR', status: 400 });
    expect(() => parseOfferIdsParam(UUIDS[0]!)).toThrowError(validation);
    expect(() => parseOfferIdsParam(`${UUIDS[0]},${UUIDS[0]}`)).toThrowError(validation);
    expect(() => parseOfferIdsParam(`${UUIDS[0]},not-a-uuid`)).toThrowError(validation);
  });

  it('absent or empty offerIds means "server picks"', () => {
    expect(parseOfferIdsParam(null)).toBeNull();
    expect(parseOfferIdsParam('   ')).toBeNull();
    expect(parseOfferIdsParam(`${UUIDS[0]}, ${UUIDS[1]}`)).toEqual([UUIDS[0], UUIDS[1]]);
  });

  it('canonical order is rank, sent_at, id — with null ranks last', () => {
    const a = candidate(UUIDS[1]!, 2, 1_000);
    const b = candidate(UUIDS[0]!, 1, 5_000);
    const c = candidate(UUIDS[2]!, null, 0);
    expect(orderCanonically([c, a, b]).map((x) => x.offerId)).toEqual([UUIDS[0], UUIDS[1], UUIDS[2]]);

    // Equal ranks fall back to sent_at, then to the id.
    const early = candidate(UUIDS[3]!, 1, 1_000);
    const late = candidate(UUIDS[0]!, 1, 2_000);
    expect(orderCanonically([late, early]).map((x) => x.offerId)).toEqual([UUIDS[3], UUIDS[0]]);
    const sameTime = [candidate(UUIDS[2]!, 1, 1_000), candidate(UUIDS[0]!, 1, 1_000)];
    expect(orderCanonically(sameTime).map((x) => x.offerId)).toEqual([UUIDS[0], UUIDS[2]]);
    expect(compareCanonical(sameTime[1]!, sameTime[1]!)).toBe(0);
  });

  it('orderCanonically never mutates its input', () => {
    const input = [candidate(UUIDS[1]!, 2, 0), candidate(UUIDS[0]!, 1, 0)];
    const before = input.map((x) => x.offerId);
    orderCanonically(input);
    expect(input.map((x) => x.offerId)).toEqual(before);
  });

  it('exactly one Top Match chosen from all comparable offers regardless of selection', () => {
    const comparable = [candidate(UUIDS[0]!, 3, 0), candidate(UUIDS[1]!, 1, 0), candidate(UUIDS[2]!, 2, 0)];
    expect(topMatchOfferId(comparable)).toBe(UUIDS[1]);

    // Selecting a subset that excludes the best-ranked offer does not move Top Match.
    const { selected } = selectForComparison(comparable, [UUIDS[0]!, UUIDS[2]!]);
    expect(selected.map((x) => x.offerId)).toEqual([UUIDS[2], UUIDS[0]]);
    expect(topMatchOfferId(comparable)).toBe(UUIDS[1]);
    expect(topMatchOfferId([])).toBeNull();
  });

  it('without ids the server picks the first three in canonical order', () => {
    const comparable = [
      candidate(UUIDS[0]!, 4, 0),
      candidate(UUIDS[1]!, 1, 0),
      candidate(UUIDS[2]!, 2, 0),
      candidate(UUIDS[3]!, 3, 0),
    ];
    const { selected, rejectedIds } = selectForComparison(comparable, null);
    expect(selected.map((x) => x.offerId)).toEqual([UUIDS[1], UUIDS[2], UUIDS[3]]);
    expect(rejectedIds).toEqual([]);
  });

  it('explicit ids are returned in canonical order and unknown ids are reported as rejected', () => {
    const comparable = [candidate(UUIDS[0]!, 2, 0), candidate(UUIDS[1]!, 1, 0)];
    const { selected, rejectedIds } = selectForComparison(comparable, [UUIDS[0]!, UUIDS[2]!]);
    expect(selected.map((x) => x.offerId)).toEqual([UUIDS[0]]);
    expect(rejectedIds).toEqual([UUIDS[2]]);
  });
});
