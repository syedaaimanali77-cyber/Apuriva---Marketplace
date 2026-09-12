import * as React from 'react';
/**
 * @startingPoint section="AI" subtitle="Parameter-bound approval for a high-risk assistant action" viewport="700x360"
 */
export interface AiConfirmParameter { label: string; value: React.ReactNode }
export interface AiConfirmationCardProps {
  title?: React.ReactNode;
  summary?: React.ReactNode;
  /** The exact parameters the confirmation is bound to. If any change, ask again. */
  parameters?: AiConfirmParameter[];
  riskLevel?: 'medium' | 'high';
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  busy?: boolean;
  style?: React.CSSProperties;
}
export declare function AiConfirmationCard(props: AiConfirmationCardProps): JSX.Element;
