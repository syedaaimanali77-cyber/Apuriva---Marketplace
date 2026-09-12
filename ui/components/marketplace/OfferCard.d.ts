import * as React from 'react';
/**
 * @startingPoint section="Marketplace" subtitle="Provider offer with price, inclusions and countdown" viewport="700x360"
 */
export interface OfferCardProps {
  providerName?: React.ReactNode;
  providerAvatar?: string;
  rating?: number;
  reviewCount?: number;
  verified?: boolean;
  /** Pre-formatted, e.g. "Rs. 3,200". The explicit offer price is always shown. */
  price?: React.ReactNode;
  arrival?: React.ReactNode;
  duration?: React.ReactNode;
  includes?: string[];
  message?: React.ReactNode;
  secondsRemaining?: number;
  expired?: boolean;
  topMatch?: boolean;
  /** Accept / Request change / Decline buttons. */
  actions?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function OfferCard(props: OfferCardProps): JSX.Element;
