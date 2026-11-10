import * as React from 'react';
export interface CardProps extends Omit<React.HTMLAttributes<HTMLElement>, 'style'> {
  /** flat for list/settings rows, subtle for interactive cards, raised for important/active ones. */
  elevation?: 'flat' | 'subtle' | 'raised' | 'overlay';
  /** Adds a brand or accent outline for active/recommended cards. */
  emphasis?: 'none' | 'brand' | 'accent';
  /** Defaults to the current density's card padding token. */
  padding?: number | string;
  /** Adds hover lift and pointer cursor. */
  interactive?: boolean;
  as?: keyof JSX.IntrinsicElements;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}
export declare function Card(props: CardProps): JSX.Element;
