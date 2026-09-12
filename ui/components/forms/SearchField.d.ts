import * as React from 'react';
/**
 * @startingPoint section="Marketplace" subtitle="Natural-language search entry with voice input" viewport="700x120"
 */
export interface SearchFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'style' | 'size' | 'onSubmit'> {
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit?: (value?: string) => void;
  placeholder?: string;
  /** Shows the microphone affordance for voice search (master spec §19). */
  voice?: boolean;
  size?: 'md' | 'lg';
  busy?: boolean;
  style?: React.CSSProperties;
}
export declare function SearchField(props: SearchFieldProps): JSX.Element;
