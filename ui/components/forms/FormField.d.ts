import * as React from 'react';
export interface FormFieldProps {
  label?: React.ReactNode;
  /** id of the control this label points at — also derives the help/error element ids. */
  htmlFor?: string;
  help?: React.ReactNode;
  /** When set, replaces the help text and renders in the error tone with an icon. */
  error?: React.ReactNode;
  required?: boolean;
  optional?: boolean;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function FormField(props: FormFieldProps): JSX.Element;
export declare function useFieldIds(id?: string): { id: string; helpId: string; errorId: string };
