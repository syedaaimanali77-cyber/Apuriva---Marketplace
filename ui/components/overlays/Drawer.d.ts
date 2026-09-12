import * as React from 'react';
export interface DrawerProps {
  open?: boolean;
  onClose?: () => void;
  title?: React.ReactNode;
  /** start/end are writing-direction aware and mirror automatically in RTL. bottom is the mobile sheet. */
  side?: 'start' | 'end' | 'bottom';
  size?: number;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Drawer(props: DrawerProps): JSX.Element | null;
