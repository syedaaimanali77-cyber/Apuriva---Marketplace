import * as React from 'react';
export interface SwitchProps {
  label?: React.ReactNode;
  description?: React.ReactNode;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (next: boolean) => void;
  id?: string;
  style?: React.CSSProperties;
}
export declare function Switch(props: SwitchProps): JSX.Element;
