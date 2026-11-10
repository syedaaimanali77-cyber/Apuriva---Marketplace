// @vitest-environment jsdom
/**
 * Spec 029 §6 / §5 accessibility — the star input must be fully keyboard-operable.
 *
 * `ui/components/marketplace/Rating` is display-only, so this input is built app-side; the risk it
 * carries is the usual one for a custom star widget — that it works with a mouse and is unusable
 * without one. These tests exist to make that failure impossible to ship unnoticed.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RatingInput } from './RatingInput';

describe('RatingInput', () => {
  it('renders a radiogroup of five named options', () => {
    render(<RatingInput value={null} onChange={() => {}} label="How was it?" />);

    const group = screen.getByRole('group', { name: 'How was it?' });
    expect(group).toBeInTheDocument();

    for (let star = 1; star <= 5; star += 1) {
      expect(screen.getByRole('radio', { name: `${star} out of 5` })).toBeInTheDocument();
    }
  });

  it('marks the selected star checked', () => {
    render(<RatingInput value={3} onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: '3 out of 5' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '2 out of 5' })).not.toBeChecked();
  });

  it('is reachable and selectable with the keyboard alone', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RatingInput value={null} onChange={onChange} />);

    // Tab reaches the group once; Space selects the focused option. No pointer involved.
    await user.tab();
    expect(screen.getByRole('radio', { name: '1 out of 5' })).toHaveFocus();

    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('moves between options with the arrow keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RatingInput value={1} onChange={onChange} />);

    await user.tab();
    await user.keyboard('{ArrowRight}');

    // Native radiogroup behaviour: arrowing selects as it moves.
    expect(onChange).toHaveBeenCalledWith(2);
  });

  it('reports the star the user clicked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RatingInput value={null} onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: '4 out of 5' }));
    expect(onChange).toHaveBeenCalledWith(4);
  });

  it('disables every option when the group is disabled', async () => {
    const onChange = vi.fn();
    render(<RatingInput value={2} onChange={onChange} disabled />);

    for (let star = 1; star <= 5; star += 1) {
      expect(screen.getByRole('radio', { name: `${star} out of 5` })).toBeDisabled();
    }
  });

  it('groups its options under one name so two inputs on a page do not collide', () => {
    const { container } = render(
      <>
        <RatingInput value={null} onChange={() => {}} name="first" />
        <RatingInput value={null} onChange={() => {}} name="second" />
      </>,
    );
    expect(container.querySelectorAll('input[name="first"]')).toHaveLength(5);
    expect(container.querySelectorAll('input[name="second"]')).toHaveLength(5);
  });
});
