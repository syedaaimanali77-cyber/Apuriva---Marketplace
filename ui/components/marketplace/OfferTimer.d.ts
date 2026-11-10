import * as React from 'react';
export interface OfferTimerProps {
  secondsRemaining?: number;
  /** The agreed offer window; Apuriva's default is 120 seconds. */
  totalSeconds?: number;
  expired?: boolean;
  size?: 'sm' | 'md';
  style?: React.CSSProperties;
}
export declare function OfferTimer(props: OfferTimerProps): JSX.Element;
