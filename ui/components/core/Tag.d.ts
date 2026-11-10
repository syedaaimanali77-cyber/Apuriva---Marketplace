import * as React from 'react';
export interface TagProps {
  children?: React.ReactNode;
  icon?: string;
  /** Renders a remove affordance. */
  onRemove?: () => void;
  /** Toggle state when used as a filter chip. */
  selected?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function Tag(props: TagProps): JSX.Element;
