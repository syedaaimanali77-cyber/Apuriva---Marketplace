import * as React from 'react';
export interface MenuItem {
  label?: React.ReactNode;
  icon?: string;
  onSelect?: () => void;
  disabled?: boolean;
  checked?: boolean;
  tone?: 'default' | 'danger';
  separator?: boolean;
}
export interface MenuProps {
  /** Element that opens the menu — receives aria-haspopup and aria-expanded. */
  trigger: React.ReactNode;
  items?: MenuItem[];
  align?: 'start' | 'end';
  style?: React.CSSProperties;
}
export declare function Menu(props: MenuProps): JSX.Element;
