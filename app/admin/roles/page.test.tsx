// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminRolesPage from './page';
import type { AdminRoleDto } from '@/lib/types/admin-rbac';

const SEVEN_ROLES: AdminRoleDto[] = [
  { id: '1', name: 'super_admin' },
  { id: '2', name: 'support_admin' },
  { id: '3', name: 'trust_safety_admin' },
  { id: '4', name: 'finance_admin' },
  { id: '5', name: 'content_admin' },
  { id: '6', name: 'operations_admin' },
  { id: '7', name: 'analytics_admin' },
];

describe('AdminRolesPage canonical roles table (spec 009 §3/§5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders each of the seven role names as visible table cell text, not blank/undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, data: SEVEN_ROLES }),
      }),
    );

    render(<AdminRolesPage />);

    const table = await screen.findByRole('table');
    const tableScope = within(table);
    for (const role of SEVEN_ROLES) {
      expect(tableScope.getByText(role.name).closest('td')).not.toBeNull();
    }
    for (const cell of table.querySelectorAll('td')) {
      expect(cell).not.toHaveTextContent('undefined');
    }
  });
});
