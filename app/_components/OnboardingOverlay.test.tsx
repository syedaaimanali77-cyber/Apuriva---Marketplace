// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OnboardingOverlay } from './OnboardingOverlay';

describe('OnboardingOverlay (spec 007 AC-1/AC-5)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('AC-1: shows a short, skippable introduction on first run', async () => {
    render(<OnboardingOverlay />);
    expect(await screen.findByRole('region', { name: 'Welcome' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip introduction' })).toBeInTheDocument();
  });

  it('AC-1: never traps focus or blocks the page behind it (not a modal — no aria-modal)', async () => {
    render(
      <>
        <button>Behind-the-overlay control</button>
        <OnboardingOverlay />
      </>,
    );
    await screen.findByRole('region', { name: 'Welcome' });
    const region = screen.getByRole('region', { name: 'Welcome' });
    expect(region).not.toHaveAttribute('aria-modal');
    // The page behind it must remain reachable/interactive.
    expect(screen.getByRole('button', { name: 'Behind-the-overlay control' })).toBeEnabled();
  });

  it('is keyboard reachable and moves focus to the Skip control on appearance', async () => {
    render(<OnboardingOverlay />);
    const skip = await screen.findByRole('button', { name: 'Skip introduction' });
    await waitFor(() => expect(skip).toHaveFocus());
  });

  it('AC-5: dismissing via the Skip control hides it and marks onboarding seen', async () => {
    const user = userEvent.setup();
    render(<OnboardingOverlay />);
    const skip = await screen.findByRole('button', { name: 'Skip introduction' });
    await user.click(skip);
    expect(screen.queryByRole('region', { name: 'Welcome' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('apuriva_onboarding_seen')).toBe('1');
  });

  it('is screen-reader dismissible via Escape', async () => {
    const user = userEvent.setup();
    render(<OnboardingOverlay />);
    await screen.findByRole('region', { name: 'Welcome' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Welcome' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('apuriva_onboarding_seen')).toBe('1');
  });

  it('AC-5: does not reappear on a later mount once already seen', () => {
    window.localStorage.setItem('apuriva_onboarding_seen', '1');
    render(<OnboardingOverlay />);
    expect(screen.queryByRole('region', { name: 'Welcome' })).not.toBeInTheDocument();
  });
});
