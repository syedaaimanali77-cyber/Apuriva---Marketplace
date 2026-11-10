import * as React from 'react';
export interface SideNavItem { id?: string; label?: string; icon?: string; badge?: number; section?: string }
export interface SideNavProps {
  items?: SideNavItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  /** dark is the navy admin/provider chrome; light is the default product chrome. */
  tone?: 'light' | 'dark';
  collapsed?: boolean;
  style?: React.CSSProperties;
}
export declare function SideNav(props: SideNavProps): JSX.Element;
