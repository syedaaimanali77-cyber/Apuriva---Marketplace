import * as React from 'react';
export interface RatingProps {
  value?: number;
  /** Review count shown in parentheses. */
  count?: number;
  size?: 'sm' | 'md' | 'lg';
  showValue?: boolean;
  style?: React.CSSProperties;
}
export declare function Rating(props: RatingProps): JSX.Element;
