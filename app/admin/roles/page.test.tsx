// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('surfaces the specific VALIDATION_ERROR field detail on assign, not just the generic message', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: SEVEN_ROLES }) })
        .mockResolvedValueOnce({
          ok: false,
          status: 400,
          json: async () => ({
            code: 'VALIDATION_ERROR',
            message: 'The request failed validation.',
            errors: [{ field: 'userId', message: 'must be a valid UUID.' }],
          }),
        }),
    );

    render(<AdminRolesPage />);

    await user.type(await screen.findByLabelText('User id'), 'not-a-uuid');
    await user.selectOptions(screen.getByLabelText('Role'), 'content_admin');
    await user.click(screen.getByRole('button', { name: 'Assign' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('userId must be a valid UUID.');
    expect(alert).not.toHaveTextContent('The request failed validation.');
  });
});
