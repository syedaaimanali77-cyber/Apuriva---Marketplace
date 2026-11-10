import * as React from 'react';
export interface RequestCardProps {
  service?: React.ReactNode;
  description?: React.ReactNode;
  when?: React.ReactNode;
  location?: React.ReactNode;
  /** Optional — customers may leave budget unset (master spec §27). */
  budget?: React.ReactNode;
  status?: 'matching' | 'offers' | 'selected' | 'expired' | 'cancelled';
  offerCount?: number;
  urgent?: boolean;
  attachments?: React.ReactNode;
  actions?: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}
export declare function RequestCard(props: RequestCardProps): JSX.Element;
