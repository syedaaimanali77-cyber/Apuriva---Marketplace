// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';
import { IconButton } from './IconButton';
import { Input } from './Input';
import { Radio, RadioGroup } from './Radio';
import { Select } from './Select';

describe('form primitives (spec 002 AC-2 — keyboard operable)', () => {
  it('Input is reachable and typeable by keyboard', async () => {
    const user = userEvent.setup();
    render(<Input aria-label="City" />);
    const input = screen.getByLabelText('City');
    await user.tab();
    expect(input).toHaveFocus();
    await user.keyboard('Lahore');
    expect(input).toHaveValue('Lahore');
  });

  it('Select is reachable by keyboard and its options are exposed to assistive tech', async () => {
    const user = userEvent.setup();
    render(<Select aria-label="City" options={['Lahore', 'Karachi']} />);
    const select = screen.getByLabelText('City');
    await user.tab();
    expect(select).toHaveFocus();
    expect(screen.getByRole('option', { name: 'Lahore' })).toBeInTheDocument();
  });

  it('Checkbox toggles via the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox label="Notify me" checked={false} onChange={onChange} />);
    const checkbox = screen.getByRole('checkbox', { name: 'Notify me' });
    await user.tab();
    expect(checkbox).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('Radio options are reachable and selectable via the keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <RadioGroup legend="Payment">
        <Radio name="pay" label="Cash" checked={false} onChange={onChange} />
        <Radio name="pay" label="Card" checked={false} onChange={onChange} />
      </RadioGroup>,
    );
    const cash = screen.getByRole('radio', { name: 'Cash' });
    await user.tab();
    expect(cash).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalled();
  });

  it('IconButton exposes an accessible name and activates via the keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton icon="x" label="Close" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Close' });
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
