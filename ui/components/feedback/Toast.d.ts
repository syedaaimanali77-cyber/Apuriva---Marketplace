import * as React from 'react';
export interface ToastProps {
  tone?: 'success' | 'error' | 'info' | 'warning';
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  onDismiss?: () => void;
  style?: React.CSSProperties;
}
export declare function Toast(props: ToastProps): JSX.Element;
export interface ToastViewportProps {
  children?: React.ReactNode;
  position?: 'bottom-right' | 'bottom-center' | 'top-right';
  style?: React.CSSProperties;
}
export declare function ToastViewport(props: ToastViewportProps): JSX.Element;
