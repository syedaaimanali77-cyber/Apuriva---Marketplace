import * as React from 'react';
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'style' | 'prefix'> {
  size?: 'sm' | 'md' | 'lg';
  iconLeft?: string;
  iconRight?: string;
  /** Static text inside the field, e.g. a currency code. */
  prefix?: React.ReactNode;
  /** Sets aria-invalid and the error border/ring. */
  invalid?: boolean;
  fullWidth?: boolean;
  style?: React.CSSProperties;
}
export declare function Input(props: InputProps): JSX.Element;
