import * as React from 'react';
/**
 * @startingPoint section="AI" subtitle="Ask Apuriva conversation shell with composer" viewport="700x520"
 */
export interface AiAssistantPanelProps {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** AiMessage / AiConfirmationCard / AiToolApproval / AiSuggestedActions children. */
  children?: React.ReactNode;
  composerValue?: string;
  onComposerChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSend?: (value?: string) => void;
  onClose?: () => void;
  placeholder?: string;
  /** Pinned content between the log and the composer — usually AiSuggestedActions. */
  footer?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function AiAssistantPanel(props: AiAssistantPanelProps): JSX.Element;
export interface AiAssistantLauncherProps { label?: string; onClick?: () => void; style?: React.CSSProperties }
export declare function AiAssistantLauncher(props: AiAssistantLauncherProps): JSX.Element;
