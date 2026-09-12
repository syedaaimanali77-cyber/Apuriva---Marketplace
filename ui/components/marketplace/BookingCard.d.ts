import * as React from 'react';
export interface BookingCardProps {
  service?: React.ReactNode;
  providerName?: React.ReactNode;
  providerAvatar?: string;
  when?: React.ReactNode;
  /** Approximate area before the booking is confirmed; exact address only after. */
  location?: React.ReactNode;
  price?: React.ReactNode;
  status?: 'upcoming' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled' | 'disputed';
  reference?: string;
  actions?: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function BookingCard(props: BookingCardProps): JSX.Element;
