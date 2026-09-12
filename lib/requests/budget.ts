import type { RequestBudget } from '@/lib/types/requests';

/**
 * Spec 015 §4 "Budget representation" — master spec §27's three shapes, mapped onto the two
 * `moneyColumns()` pairs on `requests`:
 *
 *   - omitted / `null` ("I'm not sure") -> all four columns null
 *   - target amount                     -> min = max
 *   - range                             -> min < max
 *
 * Budget is never mandatory (AC-3). Amounts are positive integers in minor units and the currency
 * is a 3-letter uppercase ISO-4217-shaped code — the same rules `moneyPairChecks()` enforces at the
 * database, validated here first so the caller gets a `400 VALIDATION_ERROR` naming the field
 * rather than a constraint violation.
 */
export interface BudgetColumns {
  budgetMinAmountMinorUnits: number | null;
  budgetMinCurrencyCode: string | null;
  budgetMaxAmountMinorUnits: number | null;
  budgetMaxCurrencyCode: string | null;
}

export const NO_BUDGET: BudgetColumns = {
  budgetMinAmountMinorUnits: null,
  budgetMinCurrencyCode: null,
  budgetMaxAmountMinorUnits: null,
  budgetMaxCurrencyCode: null,
};

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Returns the columns to persist, or the field errors to report. Never throws — the caller decides
 * how to surface the errors, so this stays usable from both the HTTP path and any future MCP tool.
 */
export function parseBudget(budget: unknown): { columns: BudgetColumns; errors: { field: string; message: string }[] } {
  if (budget === undefined || budget === null) return { columns: NO_BUDGET, errors: [] };

  if (typeof budget !== 'object' || Array.isArray(budget)) {
    return { columns: NO_BUDGET, errors: [{ field: 'budget', message: 'must be an amount, a range, or omitted' }] };
  }

  const value = budget as Record<string, unknown>;
  const isRange = 'minAmountMinorUnits' in value || 'maxAmountMinorUnits' in value;
  const errors: { field: string; message: string }[] = [];

  const currencyCode = value.currencyCode;
  if (typeof currencyCode !== 'string' || !CURRENCY_PATTERN.test(currencyCode)) {
    errors.push({ field: 'budget.currencyCode', message: 'must be a 3-letter uppercase currency code' });
  }

  if (isRange) {
    const min = value.minAmountMinorUnits;
    const max = value.maxAmountMinorUnits;
    if (!isPositiveInteger(min)) {
      errors.push({ field: 'budget.minAmountMinorUnits', message: 'must be a positive integer in minor units' });
    }
    if (!isPositiveInteger(max)) {
      errors.push({ field: 'budget.maxAmountMinorUnits', message: 'must be a positive integer in minor units' });
    }
    if (isPositiveInteger(min) && isPositiveInteger(max) && min > max) {
      errors.push({ field: 'budget.maxAmountMinorUnits', message: 'must be greater than or equal to the minimum' });
    }
    if (errors.length > 0) return { columns: NO_BUDGET, errors };

    return {
      columns: {
        budgetMinAmountMinorUnits: min as number,
        budgetMinCurrencyCode: currencyCode as string,
        budgetMaxAmountMinorUnits: max as number,
        budgetMaxCurrencyCode: currencyCode as string,
      },
      errors: [],
    };
  }

  const amount = value.amountMinorUnits;
  if (!isPositiveInteger(amount)) {
    errors.push({ field: 'budget.amountMinorUnits', message: 'must be a positive integer in minor units' });
  }
  if (errors.length > 0) return { columns: NO_BUDGET, errors };

  // §4: a target amount is stored as a zero-width range (min = max).
  return {
    columns: {
      budgetMinAmountMinorUnits: amount as number,
      budgetMinCurrencyCode: currencyCode as string,
      budgetMaxAmountMinorUnits: amount as number,
      budgetMaxCurrencyCode: currencyCode as string,
    },
    errors: [],
  };
}

/** The inverse, for `RequestDto`: min = max reads back as a target amount, min < max as a range. */
export function toBudgetDto(columns: BudgetColumns): RequestBudget | null {
  const { budgetMinAmountMinorUnits: min, budgetMaxAmountMinorUnits: max, budgetMinCurrencyCode: currency } = columns;
  if (min === null || max === null || currency === null) return null;
  if (min === max) return { amountMinorUnits: min, currencyCode: currency };
  return { minAmountMinorUnits: min, maxAmountMinorUnits: max, currencyCode: currency };
}
