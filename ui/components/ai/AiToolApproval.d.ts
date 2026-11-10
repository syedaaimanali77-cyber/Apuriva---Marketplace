import * as React from 'react';
export interface ToolArg { label: string; value: React.ReactNode }
export interface AiToolApprovalProps {
  /** Plain-language tool name, e.g. "Check Ali's availability" — not the raw MCP tool id. */
  toolLabel?: React.ReactNode;
  description?: React.ReactNode;
  args?: ToolArg[];
  state?: 'pending' | 'approved' | 'denied' | 'failed';
  /** Backend error translated into natural language; shown when state is "failed". */
  errorMessage?: React.ReactNode;
  onApprove?: () => void;
  onDeny?: () => void;
  style?: React.CSSProperties;
}
export declare function AiToolApproval(props: AiToolApprovalProps): JSX.Element;
