// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PriceDisplay } from './PriceDisplay';

describe('PriceDisplay (spec 011 AC-2)', () => {
  it('renders each pricing model correctly', () => {
    const { rerender } = render(<PriceDisplay priceDisplay={{ type: 'exact', amountMinorUnits: 5000, currencyCode: 'USD' }} />);
    expect(screen.getByText('$50.00')).toBeInTheDocument();

    rerender(<PriceDisplay priceDisplay={{ type: 'starting', amountMinorUnits: 2000, currencyCode: 'USD' }} />);
    expect(screen.getByText('From $20.00')).toBeInTheDocument();

    rerender(<PriceDisplay priceDisplay={{ type: 'range', amountMinorUnits: 1000, currencyCode: 'USD' }} />);
    expect(screen.getByText('From $10.00 (custom pricing)')).toBeInTheDocument();

    rerender(<PriceDisplay priceDisplay={{ type: 'quote' }} />);
    expect(screen.getByText('Get offers')).toBeInTheDocument();

    rerender(<PriceDisplay priceDisplay={{ type: 'hourly', amountMinorUnits: 3500, currencyCode: 'USD' }} />);
    expect(screen.getByText('$35.00/hr')).toBeInTheDocument();
  });

  it('shows a graceful fallback, never a fabricated amount, when no package exists yet', () => {
    render(<PriceDisplay priceDisplay={{ type: 'exact' }} />);
    expect(screen.getByText('Price to be confirmed')).toBeInTheDocument();
  });
});
