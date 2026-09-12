import * as React from 'react';
export interface TimelineStep { label: React.ReactNode; detail?: React.ReactNode }
export interface RequestStatusTimelineProps {
  /** Request sent → Providers notified → Offers received → Provider selected → Payment → Booking confirmed. */
  steps?: TimelineStep[];
  currentIndex?: number;
  orientation?: 'vertical' | 'horizontal';
  style?: React.CSSProperties;
}
export declare function RequestStatusTimeline(props: RequestStatusTimelineProps): JSX.Element;
