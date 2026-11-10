import * as React from 'react';
export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;
export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'name' | 'color'> {
  /** Lucide icon name as it appears in assets/icons (e.g. "map-pin", "star", "sparkles"). */
  name: string;
  size?: IconSize;
  color?: string;
  strokeWidth?: number;
  /** Accessible label. Omit for decorative icons — they are aria-hidden. */
  title?: string;
}
export declare function Icon(props: IconProps): JSX.Element | null;
