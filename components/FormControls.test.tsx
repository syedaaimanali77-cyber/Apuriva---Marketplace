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

// Spec 002 AC-2 with spec 043 D-7: the focused element itself must carry the visible indicator (a computed
// outline or box-shadow), so the design system's --ring-focus sits on the <input>/<select>, not a wrapper.
describe('form primitives (spec 002 AC-2 — focus is visibly indicated on the focused control)', () => {
  it('Input draws --ring-focus on the focused <input> itself, and removes it on blur', async () => {
    const user = userEvent.setup();
    render(<Input aria-label="City" />);
    const input = screen.getByLabelText('City');
    expect(input.style.boxShadow).toBe('none');
    await user.tab();
    expect(input).toHaveFocus();
    expect(input.style.boxShadow).toBe('var(--ring-focus)');
    expect(input.parentElement!.style.boxShadow).toBe('');
    expect(input.parentElement!.style.border).toContain('var(--field-border-focus)');
    await user.tab();
    expect(input.style.boxShadow).toBe('none');
  });

  it('an invalid Input keeps its error border and shows --ring-error on the focused <input>', async () => {
    const user = userEvent.setup();
    render(<Input aria-label="Phone" invalid />);
    const input = screen.getByLabelText('Phone');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await user.tab();
    expect(input.style.boxShadow).toBe('var(--ring-error)');
    expect(input.parentElement!.style.border).toContain('var(--field-border-error)');
  });

  it('Input still calls the consumer onFocus/onBlur, without losing the ring', async () => {
    const user = userEvent.setup();
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    render(<Input aria-label="City" onFocus={onFocus} onBlur={onBlur} />);
    const input = screen.getByLabelText('City');
    await user.tab();
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(input.style.boxShadow).toBe('var(--ring-focus)');
    await user.tab();
    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(input.style.boxShadow).toBe('none');
  });

  it('Input icons sit over the input padding, so the <input> spans the whole field', () => {
    render(<Input aria-label="Area" iconLeft="map-pin" iconRight="x" />);
    const input = screen.getByLabelText('Area');
    expect(input.style.width).toBe('100%');
    expect(input.style.paddingInlineStart).toBe('36px');
    expect(input.style.paddingInlineEnd).toBe('36px');
  });

  it('Input renders its prefix beside the text, clear of the typed value', () => {
    render(<Input aria-label="Budget" prefix="Rs." />);
    const input = screen.getByLabelText('Budget');
    expect(screen.getByText('Rs.')).toBeInTheDocument();
    // jsdom has no layout (the prefix measures 0px), so only the fixed padding and gap are asserted.
    expect(input.style.paddingInlineStart).toBe('20px');
  });

  it('Select draws --ring-focus on the focused <select> itself, and removes it on blur', async () => {
    const user = userEvent.setup();
    render(<Select aria-label="City" options={['Lahore', 'Karachi']} />);
    const select = screen.getByLabelText('City');
    expect(select.style.boxShadow).toBe('none');
    await user.tab();
    expect(select).toHaveFocus();
    expect(select.style.boxShadow).toBe('var(--ring-focus)');
    expect(select.parentElement!.style.boxShadow).toBe('');
    await user.tab();
    expect(select.style.boxShadow).toBe('none');
  });

  it('an invalid Select keeps its error border and aria-invalid while showing the focus ring', async () => {
    const user = userEvent.setup();
    const onFocus = vi.fn();
    render(<Select aria-label="City" options={['Lahore']} invalid onFocus={onFocus} />);
    const select = screen.getByLabelText('City');
    expect(select).toHaveAttribute('aria-invalid', 'true');
    await user.tab();
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(select.style.boxShadow).toBe('var(--ring-focus)');
    expect(select.parentElement!.style.border).toContain('var(--field-border-error)');
  });
});
