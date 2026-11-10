import { describe, expect, it } from 'vitest';
import { NO_BUDGET, parseBudget, toBudgetDto } from './budget';

/** Spec 015 §4 "Budget representation" / AC-3 — master spec §27's three shapes. */
describe('request budget (spec 015 AC-3)', () => {
  it('AC-3: omitted and null both mean "I\'m not sure" — never an error', () => {
    expect(parseBudget(undefined)).toEqual({ columns: NO_BUDGET, errors: [] });
    expect(parseBudget(null)).toEqual({ columns: NO_BUDGET, errors: [] });
  });

  it('stores a target amount as a zero-width range (min = max)', () => {
    const { columns, errors } = parseBudget({ amountMinorUnits: 300000, currencyCode: 'PKR' });
    expect(errors).toEqual([]);
    expect(columns).toEqual({
      budgetMinAmountMinorUnits: 300000,
      budgetMinCurrencyCode: 'PKR',
      budgetMaxAmountMinorUnits: 300000,
      budgetMaxCurrencyCode: 'PKR',
    });
  });

  it('stores a range as min < max with one shared currency', () => {
    const { columns, errors } = parseBudget({ minAmountMinorUnits: 100000, maxAmountMinorUnits: 500000, currencyCode: 'PKR' });
    expect(errors).toEqual([]);
    expect(columns).toEqual({
      budgetMinAmountMinorUnits: 100000,
      budgetMinCurrencyCode: 'PKR',
      budgetMaxAmountMinorUnits: 500000,
      budgetMaxCurrencyCode: 'PKR',
    });
  });

  it('rejects a non-integer, zero, negative or float amount — minor units are integers', () => {
    for (const amountMinorUnits of [0, -1, 1.5, '300000', Number.NaN]) {
      const { errors } = parseBudget({ amountMinorUnits, currencyCode: 'PKR' });
      expect(errors.map((e) => e.field)).toContain('budget.amountMinorUnits');
    }
  });

  it('rejects a currency that is not a 3-letter uppercase code', () => {
    for (const currencyCode of ['pkr', 'PKRR', '', 123, undefined]) {
      const { errors } = parseBudget({ amountMinorUnits: 1000, currencyCode });
      expect(errors.map((e) => e.field)).toContain('budget.currencyCode');
    }
  });

  it('rejects a range whose minimum exceeds its maximum', () => {
    const { errors, columns } = parseBudget({ minAmountMinorUnits: 500000, maxAmountMinorUnits: 100000, currencyCode: 'PKR' });
    expect(errors.map((e) => e.field)).toContain('budget.maxAmountMinorUnits');
    expect(columns).toEqual(NO_BUDGET);
  });

  it('rejects a shape that is neither an amount nor a range', () => {
    expect(parseBudget('cheap').errors[0]!.field).toBe('budget');
    expect(parseBudget([1, 2]).errors[0]!.field).toBe('budget');
  });

  it('round-trips back to the DTO: min = max reads as an amount, min < max as a range', () => {
    expect(toBudgetDto(parseBudget({ amountMinorUnits: 250000, currencyCode: 'PKR' }).columns)).toEqual({
      amountMinorUnits: 250000,
      currencyCode: 'PKR',
    });
    expect(
      toBudgetDto(parseBudget({ minAmountMinorUnits: 100000, maxAmountMinorUnits: 200000, currencyCode: 'PKR' }).columns),
    ).toEqual({ minAmountMinorUnits: 100000, maxAmountMinorUnits: 200000, currencyCode: 'PKR' });
    expect(toBudgetDto(NO_BUDGET)).toBeNull();
  });
});
