import * as React from 'react';
export interface TopBarProps {
  /** Logo or back button. */
  start?: React.ReactNode;
  /** Centre region — usually search or the page title. */
  children?: React.ReactNode;
  /** Notifications, assistant launcher, account menu. */
  end?: React.ReactNode;
  sticky?: boolean;
  tone?: 'light' | 'dark';
  style?: React.CSSProperties;
}
export declare function TopBar(props: TopBarProps): JSX.Element;
