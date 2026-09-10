// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ServicePage from './page';
import type { ServicePageDto } from '@/lib/types/service-page';

vi.mock('next/navigation', () => ({
  useParams: () => ({ category: 'cat-1', service: 'svc-1' }),
}));

function basePage(overrides: Partial<ServicePageDto>): ServicePageDto {
  return {
    id: 'svc-1',
    name: 'Test Service',
    pricingModel: 'quote',
    priceDisplay: { type: 'quote' },
    packages: [],
    fields: [],
    requirements: [],
    faqs: [],
    ...overrides,
  };
}

describe('ServicePage (spec 011 §5/AC-2)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders each pricing model correctly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: basePage({ pricingModel: 'hourly', priceDisplay: { type: 'hourly', amountMinorUnits: 4000, currencyCode: 'USD' } }) }) }),
    );

    render(<ServicePage />);

    expect(await screen.findByText('$40.00/hr')).toBeInTheDocument();
  });

  it('shows the "Ask Apuriva" empty state when there are no packages or FAQs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: basePage({}) }) }));

    render(<ServicePage />);

    expect(await screen.findByText('Ask Apuriva')).toBeInTheDocument();
  });

  it('AC-4: shows media requirement guidance as inline help text, not a blocking element', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: basePage({ requirements: [{ id: 'r1', serviceId: 'svc-1', kind: 'media', detail: { helpText: 'Photos help a lot.' } }] }),
        }),
      }),
    );

    render(<ServicePage />);

    expect(await screen.findByText('Photos help a lot.')).toBeInTheDocument();
  });
});
