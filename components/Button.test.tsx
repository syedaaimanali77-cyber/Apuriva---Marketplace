// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';

describe('Button (spec 002 AC-2)', () => {
  it('is a native button, reachable by Tab and activatable by keyboard alone', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Confirm</Button>);

    const button = screen.getByRole('button', { name: 'Confirm' });
    expect(button.tagName).toBe('BUTTON');

    await user.tab();
    expect(button).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);

    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('is removed from the tab order and not activatable while disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick} disabled>Confirm</Button>);

    const button = screen.getByRole('button', { name: 'Confirm' });
    expect(button).toBeDisabled();

    await user.tab();
    expect(button).not.toHaveFocus();
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('signals the loading state via aria-busy, not color/spinner alone', () => {
    render(<Button loading>Saving</Button>);
    const button = screen.getByRole('button', { name: 'Saving' });
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});
