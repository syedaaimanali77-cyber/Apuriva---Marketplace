'use client';

import * as React from 'react';
import { Input } from '@/ui/components/forms/Input';

export interface OtpInputProps
  extends Pick<React.InputHTMLAttributes<HTMLInputElement>, 'id' | 'aria-describedby' | 'aria-label' | 'aria-labelledby'> {
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  length?: number;
  invalid?: boolean;
  disabled?: boolean;
}

/**
 * New for spec 005 §5 (not part of the existing `ui/` bundle — built on its `Input` primitive so
 * it inherits the same tokens/focus/RTL behavior rather than introducing a separate styling
 * approach). A single accessible text field rather than per-digit boxes: one screen-reader
 * announcement, trivial paste-of-full-code support, and no custom multi-box focus management to
 * get subtly wrong.
 */
export function OtpInput({ value, onChange, onComplete, length = 6, invalid, disabled, ...rest }: OtpInputProps) {
  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const digitsOnly = event.target.value.replace(/\D/g, '').slice(0, length);
    onChange(digitsOnly);
    if (digitsOnly.length === length) onComplete?.(digitsOnly);
  };

  return (
    <Input
      {...rest}
      value={value}
      onChange={handleChange}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="\d*"
      // Deliberately no native `maxLength`: it would truncate a paste like "Your code is:
      // 123456" to its first 6 *characters* before handleChange ever gets to strip the
      // non-digits, losing the real code. `handleChange` enforces the true 6-*digit* cap
      // itself, after filtering, then this controlled value re-renders the field to match.
      invalid={invalid}
      disabled={disabled}
      style={{ letterSpacing: '0.5em', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
    />
  );
}
