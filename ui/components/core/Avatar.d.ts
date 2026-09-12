import * as React from 'react';
export interface AvatarProps {
  src?: string;
  /** Used for the alt text and for the initials fallback. */
  name?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;
  shape?: 'circle' | 'rounded';
  /** Shows the teal verification tick used on verified provider profiles. */
  verified?: boolean;
  style?: React.CSSProperties;
}
export declare function Avatar(props: AvatarProps): JSX.Element;
