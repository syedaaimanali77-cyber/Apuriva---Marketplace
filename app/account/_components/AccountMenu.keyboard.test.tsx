// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountMenu } from './AccountMenu';

/**
 * Spec 006 §5 ("fully keyboard operable") under the ARIA menu-button pattern, found by spec 043's
 * browser keyboard walk (`browser/a11y/keyboard.browser.ts`): opening the menu with Enter must move
 * focus inside it, so Arrow keys and Escape work from there.
 */
function jsonResponse(ok: boolean, body: unknown) {
  return { ok, json: async () => body };
}

const USER = { id: 'user-1', hasCustomerProfile: true, hasProviderProfile: true, activeMode: 'customer' as const, isAdmin: false };

describe('AccountMenu keyboard (ARIA menu button)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('Enter opens the menu and focuses its first enabled item; Arrow keys move within it; Escape returns focus', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(true, { data: USER })));

    render(<AccountMenu />);
    const trigger = await screen.findByRole('button', { name: 'Account menu' });
    trigger.focus();
    await user.keyboard('{Enter}');

    const menu = screen.getByRole('menu');
    // The current-mode item is disabled, so the first enabled item is the provider switch.
    const providerItem = screen.getByRole('menuitem', { name: 'Switch to provider mode' });
    expect(providerItem).toHaveFocus();
    expect(menu).toContainElement(document.activeElement as HTMLElement);

    await user.keyboard('{ArrowDown}');
    expect(providerItem).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
