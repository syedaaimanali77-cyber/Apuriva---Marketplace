import * as React from 'react';
export interface NavItem { id: string; label: string; icon: string; badge?: number }
export interface BottomTabBarProps {
  /** Customer: Home, Explore, Requests, Bookings, Account. Provider: Dashboard, Requests, Schedule, Earnings, Account. */
  items?: NavItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  style?: React.CSSProperties;
}
export declare function BottomTabBar(props: BottomTabBarProps): JSX.Element;
