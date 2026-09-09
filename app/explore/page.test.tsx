// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ExplorePage from './page';
import type { CategoryDto } from '@/lib/types/catalog';

const CATEGORY: CategoryDto = {
  id: '1',
  name: 'Cleaning',
  slug: 'cleaning',
  status: 'published',
  sortOrder: 1,
  subcategories: [],
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('ExplorePage (spec 010 §3/AC-5/§5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders published categories from GET /api/v1/categories', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [CATEGORY] }) }),
    );

    render(<ExplorePage />);

    expect(await screen.findByText('Cleaning')).toBeInTheDocument();
  });

  it('shows an empty state when there are no published categories', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [] }) }));

    render(<ExplorePage />);

    expect(await screen.findByText('No categories yet')).toBeInTheDocument();
  });

  it('shows an error state when the read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ code: 'INTERNAL_ERROR', message: 'boom' }) }),
    );

    render(<ExplorePage />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});
