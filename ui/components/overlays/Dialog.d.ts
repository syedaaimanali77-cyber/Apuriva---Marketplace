import * as React from 'react';
export interface DialogProps {
  open?: boolean;
  onClose?: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Action row pinned to the bottom, right-aligned (start-aligned mirrors in RTL). */
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** false for flows the user must resolve — hides the close button and disables Escape. */
  dismissible?: boolean;
  style?: React.CSSProperties;
}
export declare function Dialog(props: DialogProps): JSX.Element | null;
