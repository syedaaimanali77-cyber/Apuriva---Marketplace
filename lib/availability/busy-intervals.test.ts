import { afterEach, describe, expect, it } from 'vitest';
import { getBusyIntervalLoader, registerBusyIntervalLoader, resetBusyIntervalLoader, type BusyInterval } from './busy-intervals';

/**
 * Spec 016 §3 "Interface with spec 020" — the boundary this spec depends on. These tests pin the
 * contract, so a later change that starts reading `bookings` from inside `lib/availability/*`
 * would have to break one of them deliberately.
 */
describe('busy-interval port (spec 016 §3)', () => {
  afterEach(() => {
    resetBusyIntervalLoader();
  });

  it('defaults to "nothing is occupied" before spec 020 registers a loader', async () => {
    const loader = getBusyIntervalLoader();
    const intervals = await loader({} as never, 'provider-1', { from: new Date(0), to: new Date(1) });

    // Correct rather than a stub: no code can create a booking with a scheduled time until spec
    // 020 adds those columns, so there is genuinely nothing occupied yet.
    expect(intervals).toEqual([]);
  });

  it('uses the registered loader once spec 020 provides one', async () => {
    const supplied: BusyInterval[] = [
      { startAt: new Date('2026-09-16T05:00:00Z'), endAt: new Date('2026-09-16T06:00:00Z'), serviceId: 's', sourceId: 'b1' },
    ];
    registerBusyIntervalLoader(async () => supplied);

    const intervals = await getBusyIntervalLoader()({} as never, 'provider-1', { from: new Date(0), to: new Date(1) });
    expect(intervals).toEqual(supplied);
  });

  it('passes the provider and range through to the loader unchanged', async () => {
    const seen: { providerProfileId: string; from: Date; to: Date }[] = [];
    registerBusyIntervalLoader(async (_tx, providerProfileId, range) => {
      seen.push({ providerProfileId, from: range.from, to: range.to });
      return [];
    });

    const from = new Date('2026-09-16T00:00:00Z');
    const to = new Date('2026-09-17T00:00:00Z');
    await getBusyIntervalLoader()({} as never, 'provider-42', { from, to });

    expect(seen).toEqual([{ providerProfileId: 'provider-42', from, to }]);
  });

  it('resets back to the default, so one suite cannot leak a loader into another', async () => {
    registerBusyIntervalLoader(async () => [
      { startAt: new Date(0), endAt: new Date(1), serviceId: 's', sourceId: 'leak' },
    ]);
    resetBusyIntervalLoader();

    expect(await getBusyIntervalLoader()({} as never, 'p', { from: new Date(0), to: new Date(1) })).toEqual([]);
  });
});
