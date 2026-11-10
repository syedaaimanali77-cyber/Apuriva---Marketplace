import * as React from 'react';
/**
 * @startingPoint section="Marketplace" subtitle="Catalog tile with pricing model and rating" viewport="700x330"
 */
export interface ServiceCardProps {
  name?: React.ReactNode;
  category?: React.ReactNode;
  image?: string;
  /** Pre-formatted price string, e.g. "Rs. 2,500". Format at the presentation layer. */
  price?: React.ReactNode;
  /** Drives the price prefix/suffix: fixed exact, package "From", hourly "/hr", variable "Typically", quote "Get offers". */
  priceModel?: 'fixed' | 'package' | 'hourly' | 'variable' | 'quote';
  duration?: React.ReactNode;
  rating?: number;
  reviewCount?: number;
  /** Amber highlight pill, e.g. "Popular". */
  badge?: React.ReactNode;
  providerCount?: number;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function ServiceCard(props: ServiceCardProps): JSX.Element;
