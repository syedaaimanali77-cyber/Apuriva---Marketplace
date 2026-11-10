import * as React from 'react';
export interface ErrorStateProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Correlation id — shown small and monospaced for support, never a raw stack trace. */
  traceId?: string;
  onRetry?: () => void;
  retryLabel?: string;
  secondaryAction?: React.ReactNode;
  compact?: boolean;
  style?: React.CSSProperties;
}
export declare function ErrorState(props: ErrorStateProps): JSX.Element;
