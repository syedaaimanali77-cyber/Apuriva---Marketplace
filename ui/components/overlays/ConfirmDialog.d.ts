import * as React from 'react';
export interface ConfirmParameter { label: string; value: React.ReactNode }
export interface ConfirmDialogProps {
  open?: boolean;
  onCancel?: () => void;
  onConfirm?: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** The exact parameters being confirmed — provider, service, time, price, currency. */
  parameters?: ConfirmParameter[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'primary' | 'danger';
  busy?: boolean;
}
export declare function ConfirmDialog(props: ConfirmDialogProps): JSX.Element;
