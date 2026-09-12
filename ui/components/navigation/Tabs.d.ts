import * as React from 'react';
export interface TabItem { id: string; label: React.ReactNode; count?: number }
export interface TabsProps {
  items?: TabItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  /** underline for page-level sections, pill for compact in-card filters. */
  variant?: 'underline' | 'pill';
  style?: React.CSSProperties;
}
export declare function Tabs(props: TabsProps): JSX.Element;
