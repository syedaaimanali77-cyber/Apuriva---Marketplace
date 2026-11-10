// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OtpInput } from './OtpInput';

function Controlled({ onComplete }: { onComplete?: (v: string) => void }) {
  const [value, setValue] = useState('');
  return <OtpInput value={value} onChange={setValue} onComplete={onComplete} aria-label="Verification code" />;
}

describe('OtpInput (spec 005 §5 — keyboard operable, paste support)', () => {
  it('is reachable and typeable by keyboard', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const input = screen.getByLabelText('Verification code');
    await user.tab();
    expect(input).toHaveFocus();
    await user.keyboard('123456');
    expect(input).toHaveValue('123456');
  });

  it('strips non-digit characters', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const input = screen.getByLabelText('Verification code');
    await user.click(input);
    await user.paste('12a3b4c5d6');
    expect(input).toHaveValue('123456');
  });

  it('calls onComplete once the full length is reached', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Controlled onComplete={onComplete} />);
    const input = screen.getByLabelText('Verification code');
    await user.click(input);
    await user.keyboard('12345');
    expect(onComplete).not.toHaveBeenCalled();
    await user.keyboard('6');
    expect(onComplete).toHaveBeenCalledWith('123456');
  });

  it('supports pasting the full code at once', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<Controlled onComplete={onComplete} />);
    const input = screen.getByLabelText('Verification code');
    await user.click(input);
    await user.paste('654321');
    expect(input).toHaveValue('654321');
    expect(onComplete).toHaveBeenCalledWith('654321');
  });

  it('never exceeds the configured length', async () => {
    const user = userEvent.setup();
    render(<Controlled />);
    const input = screen.getByLabelText('Verification code');
    await user.click(input);
    await user.paste('123456789');
    expect(input).toHaveValue('123456');
  });
});
