import * as React from 'react';
export interface StatBlockProps {
  label?: React.ReactNode;
  value?: React.ReactNode;
  unit?: React.ReactNode;
  /** e.g. "+12% vs last week". Pair with deltaTone. */
  delta?: React.ReactNode;
  deltaTone?: 'success' | 'error';
  icon?: string;
  hint?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function StatBlock(props: StatBlockProps): JSX.Element;
