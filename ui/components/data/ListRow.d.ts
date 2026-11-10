import * as React from 'react';
export interface ListRowProps {
  icon?: string;
  /** Render an <Avatar> here for people rows. */
  avatar?: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  meta?: React.ReactNode;
  action?: React.ReactNode;
  onClick?: () => void;
  chevron?: boolean;
  selected?: boolean;
  style?: React.CSSProperties;
}
export declare function ListRow(props: ListRowProps): JSX.Element;
