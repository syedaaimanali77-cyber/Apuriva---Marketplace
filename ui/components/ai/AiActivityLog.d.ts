import * as React from 'react';
export interface AiActivityEntry {
  label: React.ReactNode;
  detail?: React.ReactNode;
  time?: React.ReactNode;
  status?: 'done' | 'failed';
  /** Marks actions that required and received explicit user confirmation. */
  confirmed?: boolean;
}
export interface AiActivityGroup { label: string; entries: AiActivityEntry[] }
export interface AiActivityLogProps { groups?: AiActivityGroup[]; style?: React.CSSProperties }
export declare function AiActivityLog(props: AiActivityLogProps): JSX.Element;
