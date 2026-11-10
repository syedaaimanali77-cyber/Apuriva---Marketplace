import * as React from 'react';
export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'style' | 'type'> {
  label?: React.ReactNode;
  description?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Radio(props: RadioProps): JSX.Element;
export interface RadioGroupProps { legend?: React.ReactNode; children?: React.ReactNode; style?: React.CSSProperties }
export declare function RadioGroup(props: RadioGroupProps): JSX.Element;
