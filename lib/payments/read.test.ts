import { describe, expect, it } from 'vitest';
import { toPaymentDto, toPriceAdjustmentDto } from './read';

/**
 * Spec 021 §3 "AI and MCP boundary" (AC-8) — the projection consumers report from.
 *
 * These are pure-mapping assertions, deliberately: the guarantee AC-8 needs is that the DTO is a
 * projection of persisted columns with no branch that could synthesize a status. That is provable
 * from the mapper alone, and it is where a future regression would be introduced.
 */
describe('payment read projection (spec 021 AC-8)', () => {
  const row = {
    id: 'p1',
    booking_id: 'b1',
    status: 'captured' as const,
    charge_amount_minor_units: 320_000,
    charge_currency_code: 'PKR',
    protection_state: 'held' as const,
    protection_window_started_at: new Date('2026-09-01T10:00:00.000Z'),
    protection_window_hours: 48,
    created_at: new Date('2026-09-01T09:00:00.000Z'),
    updated_at: new Date('2026-09-01T09:30:00.000Z'),
    version: 3,
  };

  it('returns only persisted state and omits providerReference', () => {
    const dto = toPaymentDto(row);

    expect(dto).toEqual({
      id: 'p1',
      bookingId: 'b1',
      status: 'captured',
      chargeAmountMinorUnits: 320_000,
      chargeCurrencyCode: 'PKR',
      protectionState: 'held',
      protectionWindowStartedAt: '2026-09-01T10:00:00.000Z',
      protectionWindowHours: 48,
      protectionWindowEndsAt: '2026-09-03T10:00:00.000Z',
      createdAt: '2026-09-01T09:00:00.000Z',
      updatedAt: '2026-09-01T09:30:00.000Z',
      version: 3,
    });

    // §4 "Retention and privacy": the provider handle never crosses this boundary.
    expect(Object.keys(dto)).not.toContain('providerReference');
    expect(Object.keys(dto)).not.toContain('providerName');
    expect(Object.keys(dto)).not.toContain('idempotencyKey');
    expect(JSON.stringify(dto)).not.toMatch(/sandbox_/);
  });

  /**
   * The status is copied verbatim. A mapper that "helpfully" upgraded, defaulted or inferred a
   * status would be exactly the fabricated success master spec §132.7 forbids.
   */
  it('copies the status verbatim for every value, inferring none', () => {
    for (const status of ['created', 'requires_action', 'authorized', 'captured', 'failed'] as const) {
      expect(toPaymentDto({ ...row, status }).status).toBe(status);
    }
  });

  /** An unopened window yields nulls, never a synthesized deadline that could release early. */
  it('reports no protection window until one has opened', () => {
    const dto = toPaymentDto({ ...row, protection_state: null, protection_window_started_at: null });
    expect(dto.protectionState).toBeNull();
    expect(dto.protectionWindowStartedAt).toBeNull();
    expect(dto.protectionWindowEndsAt).toBeNull();
    // The configured duration is still reported, so a UI can say how long protection will last.
    expect(dto.protectionWindowHours).toBe(48);
  });

  it('derives the window end from the stored start and duration', () => {
    expect(toPaymentDto({ ...row, protection_window_hours: 2 }).protectionWindowEndsAt).toBe(
      '2026-09-01T12:00:00.000Z',
    );
  });

  it('projects a price adjustment without its idempotency or actor columns', () => {
    const dto = toPriceAdjustmentDto({
      id: 'a1',
      booking_id: 'b1',
      additional_amount_minor_units: 45_000,
      additional_currency_code: 'PKR',
      reason: 'Replacement part',
      status: 'charged',
      approved_at: new Date('2026-09-01T11:00:00.000Z'),
      created_at: new Date('2026-09-01T10:30:00.000Z'),
      version: 2,
    });

    expect(dto.additionalAmountMinorUnits).toBe(45_000);
    expect(dto.additionalCurrencyCode).toBe('PKR');
    expect(dto.approvedAt).toBe('2026-09-01T11:00:00.000Z');
    expect(Object.keys(dto)).not.toContain('idempotencyKey');
    expect(Object.keys(dto)).not.toContain('proposedByUserId');
    expect(Object.keys(dto)).not.toContain('approvedByUserId');
  });
});
