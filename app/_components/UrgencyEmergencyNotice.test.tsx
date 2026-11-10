// @vitest-environment jsdom
/**
 * Spec 030 §6 (AC-6) — the marketplace-not-emergency disclosure.
 *
 * AC-6's wording is "a VISIBLE, non-fine-print notice", so these tests assert placement and
 * prominence, not just that the words exist somewhere in the DOM. A tooltip containing the right
 * sentence would satisfy a naive test and fail the acceptance criterion.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UrgencyEmergencyNotice } from './UrgencyEmergencyNotice';

describe('UrgencyEmergencyNotice (AC-6)', () => {
  it('states plainly that Apuriva is not an emergency service', () => {
    render(<UrgencyEmergencyNotice />);
    expect(screen.getByText(/not an emergency service/i)).toBeInTheDocument();
  });

  it('directs genuine emergencies to local emergency services', () => {
    render(<UrgencyEmergencyNotice />);
    expect(screen.getByText(/local emergency services/i)).toBeInTheDocument();
  });

  it('names no specific emergency number (DECIDED-6 — no locale resolution exists)', () => {
    const { container } = render(<UrgencyEmergencyNotice />);
    // A wrong number in an emergency is worse than none, and master §65 says only "appropriate
    // local emergency services".
    expect(container.textContent).not.toMatch(/\b(999|911|112|000|119)\b/);
  });

  it('says what marking a request urgent actually does, so the option is not merely discouraged', () => {
    render(<UrgencyEmergencyNotice />);
    expect(screen.getByText(/helps us find a provider sooner/i)).toBeInTheDocument();
  });

  it('is exposed as a landmark a screen reader announces rather than skips', () => {
    render(<UrgencyEmergencyNotice />);
    expect(screen.getByRole('note', { name: 'Emergency guidance' })).toBeInTheDocument();
  });

  it('is rendered inline and visible — never a tooltip, a title attribute or a collapsed disclosure', () => {
    const { container } = render(<UrgencyEmergencyNotice />);
    expect(container.querySelector('[title]')).toBeNull();
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('[hidden]')).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('renders in both the standalone and the host-card variant', () => {
    const { rerender } = render(<UrgencyEmergencyNotice />);
    expect(screen.getByRole('note')).toBeInTheDocument();
    rerender(<UrgencyEmergencyNotice standalone={false} />);
    expect(screen.getByRole('note')).toBeInTheDocument();
  });
});
