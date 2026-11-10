import * as React from 'react';
export interface ActiveBookingBannerProps {
  status?: React.ReactNode;
  service?: React.ReactNode;
  providerName?: React.ReactNode;
  providerAvatar?: string;
  when?: React.ReactNode;
  action?: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function ActiveBookingBanner(props: ActiveBookingBannerProps): JSX.Element;
