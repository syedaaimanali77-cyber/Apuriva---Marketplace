// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminCatalogPage from './page';
import type { CategoryDto } from '@/lib/types/catalog';

const CATEGORY: CategoryDto = {
  id: 'cat-1',
  name: 'Cleaning',
  slug: 'cleaning',
  status: 'published',
  sortOrder: 1,
  subcategories: [{ id: 'sub-1', categoryId: 'cat-1', name: 'Deep Clean', slug: 'deep-clean', status: 'draft', version: 1, createdAt: '', updatedAt: '' }],
  version: 1,
  createdAt: '',
  updatedAt: '',
};

function mockFetchSequence(...responses: { ok: boolean; status: number; json: () => Promise<unknown> }[]) {
  const fn = vi.fn();
  for (const r of responses) fn.mockResolvedValueOnce(r);
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('AdminCatalogPage (spec 010 §5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders categories and their nested subcategories once loaded', async () => {
    mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ data: [CATEGORY] }) },
      { ok: true, status: 200, json: async () => ({ data: [] }) },
    );

    render(<AdminCatalogPage />);

    const table = await screen.findByRole('table', { name: 'All categories' });
    expect(within(table).getByText('Cleaning')).toBeInTheDocument();
    expect(await screen.findByText('Deep Clean')).toBeInTheDocument();
  });

  it('shows a forbidden state for a non-Content/Marketplace admin', async () => {
    mockFetchSequence(
      { ok: false, status: 403, json: async () => ({ code: 'FORBIDDEN', message: 'nope' }) },
      { ok: false, status: 403, json: async () => ({ code: 'FORBIDDEN', message: 'nope' }) },
    );

    render(<AdminCatalogPage />);

    expect(await screen.findByText('Content/Marketplace admin required')).toBeInTheDocument();
  });

  it('surfaces the specific field-level validation error on category creation, not a generic message', async () => {
    const user = userEvent.setup();
    mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ data: [] }) },
      { ok: true, status: 200, json: async () => ({ data: [] }) },
      {
        ok: false,
        status: 400,
        json: async () => ({ code: 'VALIDATION_ERROR', message: 'The request failed validation.', errors: [{ field: 'slug', message: 'is already in use' }] }),
      },
    );

    render(<AdminCatalogPage />);
    await screen.findByRole('table', { name: 'All categories' });

    // "Name"/"Slug" labels repeat across the Category/Subcategory/Service forms — the category
    // fields render first in document order.
    await user.type(screen.getAllByLabelText('Name')[0]!, 'Duplicate');
    await user.type(screen.getAllByLabelText('Slug')[0]!, 'duplicate');
    await user.click(screen.getByRole('button', { name: 'Create category' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('slug is already in use');
  });

  it('renders pending AI suggestions with Approve/Reject actions', async () => {
    mockFetchSequence(
      { ok: true, status: 200, json: async () => ({ data: [] }) },
      {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: 'sugg-1',
              entityType: 'category',
              proposedName: 'AI Category',
              proposedSlug: 'ai-category',
              categoryId: null,
              subcategoryId: null,
              pricingModel: null,
              metadata: {},
              rationale: 'trending',
              source: 'ai_assistant',
              status: 'pending_review',
              createdAt: '',
              reviewedAt: null,
              reviewedBy: null,
              resultingEntityId: null,
            },
          ],
        }),
      },
    );

    render(<AdminCatalogPage />);

    expect(await screen.findByText('AI Category')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });
});
