import * as React from 'react';
export interface AiMessageProps {
  role?: 'assistant' | 'user';
  children?: React.ReactNode;
  timestamp?: React.ReactNode;
  /** Renders the typing indicator instead of children. */
  pending?: boolean;
  style?: React.CSSProperties;
}
export declare function AiMessage(props: AiMessageProps): JSX.Element;
