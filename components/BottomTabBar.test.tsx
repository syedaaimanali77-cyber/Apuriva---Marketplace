// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BottomTabBar } from '@/ui/components/navigation/BottomTabBar';

// Spec 002 AC-4: the design system's BottomTabBar unread badge is normal-size text (10px bold), so it uses the
// --action-accent-fg on --action-accent-bg pair, which components/tokens.test.ts holds to 4.5:1.
describe('BottomTabBar unread badge (spec 002 AC-4)', () => {
  it('uses the semantic accent tokens, never a raw palette colour', () => {
    render(<BottomTabBar items={[{ id: 'inbox', label: 'Inbox', icon: 'message-circle', badge: 3 }]} activeId="inbox" />);
    const badge = screen.getByLabelText('3 new');
    expect(badge).toHaveTextContent('3');
    expect(badge.style.background).toBe('var(--action-accent-bg)');
    expect(badge.style.color).toBe('var(--action-accent-fg)');
  });

  it('renders no badge when an item has none', () => {
    render(<BottomTabBar items={[{ id: 'home', label: 'Home', icon: 'house' }]} />);
    expect(screen.queryByLabelText(/new$/)).toBeNull();
  });
});
