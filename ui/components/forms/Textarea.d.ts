import * as React from 'react';
export interface TextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'style'> {
  invalid?: boolean;
  /** Shows a live character counter when set. */
  maxLength?: number;
  style?: React.CSSProperties;
}
export declare function Textarea(props: TextareaProps): JSX.Element;
