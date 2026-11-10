import * as React from 'react';
export interface TableColumn<T = any> {
  key: string;
  header: React.ReactNode;
  align?: 'start' | 'center' | 'end';
  width?: number | string;
  numeric?: boolean;
  render?: (row: T) => React.ReactNode;
}
export interface TableProps<T = any> {
  columns?: TableColumn<T>[];
  rows?: T[];
  /** Visually hidden caption — required for screen-reader context on admin tables. */
  caption?: string;
  density?: 'dense' | 'comfortable';
  onRowClick?: (row: T) => void;
  emptyMessage?: React.ReactNode;
  style?: React.CSSProperties;
}
export declare function Table<T>(props: TableProps<T>): JSX.Element;
