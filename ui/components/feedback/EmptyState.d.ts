import * as React from 'react';
export interface EmptyStateProps {
  icon?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  secondaryAction?: React.ReactNode;
  /** Next-step suggestions — Apuriva empty states never dead-end (master spec §22). */
  suggestions?: string[];
  compact?: boolean;
  style?: React.CSSProperties;
}
export declare function EmptyState(props: EmptyStateProps): JSX.Element;
