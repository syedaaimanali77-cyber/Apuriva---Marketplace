import * as React from 'react';
/**
 * @startingPoint section="Marketplace" subtitle="Provider result with rating, availability and match reason" viewport="700x300"
 */
export interface ProviderCardProps {
  name?: React.ReactNode;
  headline?: React.ReactNode;
  avatar?: string;
  rating?: number;
  reviewCount?: number;
  /** Approximate distance only — exact coordinates are never exposed before booking. */
  distance?: React.ReactNode;
  verified?: boolean;
  availability?: 'available' | 'busy' | 'unavailable';
  priceFrom?: React.ReactNode;
  tags?: string[];
  /** Amber "Top match" emphasis from the ranking engine. */
  topMatch?: boolean;
  /** Plain-language explanation of why this provider surfaced (master spec §2.3). */
  reason?: React.ReactNode;
  actions?: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function ProviderCard(props: ProviderCardProps): JSX.Element;
