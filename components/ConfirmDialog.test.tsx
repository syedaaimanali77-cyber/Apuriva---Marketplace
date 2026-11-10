// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog (spec 008 §5 destructive confirmation)', () => {
  it('renders nothing when closed', () => {
    render(
      <ConfirmDialog open={false} title="Delete?" onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('exposes an accessible name/description and states the consequence plainly', () => {
    render(
      <ConfirmDialog
        open
        title="Log out all other devices?"
        description="Every other session will be signed out immediately."
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Log out all other devices?' });
    expect(dialog).toHaveAccessibleDescription('Every other session will be signed out immediately.');
  });

  it('moves focus into the dialog when it opens, and calling onConfirm/onCancel works by keyboard alone', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Delete your account?" confirmLabel="Delete" onConfirm={onConfirm} onCancel={onCancel} />);

    expect(document.activeElement).toHaveAccessibleName('Delete');

    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledTimes(1);

    await user.tab({ shift: true });
    await user.keyboard('{Enter}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('traps Tab focus within the two buttons — Tab from the last wraps to the first', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog open title="Delete your account?" onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    const confirmButton = screen.getByRole('button', { name: 'Confirm' });
    expect(document.activeElement).toBe(confirmButton);

    await user.tab();
    expect(document.activeElement).toBe(cancelButton);
    await user.tab();
    expect(document.activeElement).toBe(confirmButton);
  });

  it('Escape cancels unless a confirm is already pending', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const { rerender } = render(<ConfirmDialog open title="Delete?" onConfirm={vi.fn()} onCancel={onCancel} />);
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);

    onCancel.mockClear();
    rerender(<ConfirmDialog open pending title="Delete?" onConfirm={vi.fn()} onCancel={onCancel} />);
    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('the confirm button announces the pending state via aria-busy', () => {
    render(<ConfirmDialog open pending title="Delete?" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveAttribute('aria-busy', 'true');
  });

  it('restores focus to the previously-focused element after closing', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <ConfirmDialog open={open} title="Delete?" onConfirm={vi.fn()} onCancel={() => setOpen(false)} />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    await user.click(trigger);
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(trigger);
  });
});
