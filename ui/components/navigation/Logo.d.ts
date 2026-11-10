import * as React from 'react';
export interface LogoProps {
  /** Path to the supplied logo artwork (assets/apuriva-logo-full.jpeg). Omit for the type-only wordmark. */
  src?: string;
  variant?: 'full' | 'mark';
  size?: number;
  tagline?: boolean;
  tone?: 'dark' | 'light';
  style?: React.CSSProperties;
}
export declare function Logo(props: LogoProps): JSX.Element;
