import * as React from 'react';
/**
 * @startingPoint section="Core" subtitle="Primary, secondary, ghost, accent and danger actions" viewport="700x220"
 */
export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  /** primary = the one committing action on a view. accent (amber) is for highlights, never warnings. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'accent' | 'danger' | 'inverse';
  size?: 'sm' | 'md' | 'lg';
  /** Icon name from the bundled Lucide set. */
  iconLeft?: string;
  iconRight?: string;
  /** Shows a spinner, sets aria-busy and blocks activation. */
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}
export declare function Button(props: ButtonProps): JSX.Element;
