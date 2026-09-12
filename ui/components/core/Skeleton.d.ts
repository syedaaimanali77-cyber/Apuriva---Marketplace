import * as React from 'react';
export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: string;
  /** Renders a stack of bars; the last one is shortened like a paragraph tail. */
  lines?: number;
  gap?: number;
  style?: React.CSSProperties;
}
export declare function Skeleton(props: SkeletonProps): JSX.Element;
