import * as React from 'react';
export interface SelectOption { value: string; label: string; disabled?: boolean }
export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'style'> {
  options?: Array<SelectOption | string>;
  size?: 'sm' | 'md' | 'lg';
  invalid?: boolean;
  placeholder?: string;
  style?: React.CSSProperties;
}
export declare function Select(props: SelectProps): JSX.Element;
