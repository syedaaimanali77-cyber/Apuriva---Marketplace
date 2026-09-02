// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from './Badge';

describe('Badge (spec 002 AC-3)', () => {
  it.each([
    ['success', 'Booking confirmed'],
    ['warning', 'Action needed'],
    ['error', 'Payment failed'],
    ['info', 'New feature'],
  ] as const)('renders icon + text + color together for tone=%s, never color alone', (tone, text) => {
    render(<Badge tone={tone}>{text}</Badge>);

    const badge = screen.getByText(text);
    // text is present, on the badge's own root element
    expect(badge).toBeInTheDocument();
    // an icon (svg) is present alongside the text, not color-only
    expect(badge.querySelector('svg')).toBeTruthy();
    // a tone color is actually applied, not left to default/inherited black
    expect(badge.style.color).toMatch(/var\(--status-.+-fg\)/);
  });

  it('still renders text when an icon is explicitly suppressed (icon={null})', () => {
    render(
      <Badge tone="success" icon={null}>
        Text-only fallback
      </Badge>,
    );
    const badge = screen.getByText('Text-only fallback');
    expect(badge.querySelector('svg')).toBeNull();
    expect(badge).toBeInTheDocument();
  });
});
