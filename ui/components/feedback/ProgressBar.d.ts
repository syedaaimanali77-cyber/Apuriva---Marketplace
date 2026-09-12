import * as React from 'react';
export interface ProgressBarProps {
  value?: number;
  max?: number;
  label?: React.ReactNode;
  tone?: 'brand' | 'accent' | 'success' | 'error';
  showValue?: boolean;
  indeterminate?: boolean;
  style?: React.CSSProperties;
}
export declare function ProgressBar(props: ProgressBarProps): JSX.Element;
