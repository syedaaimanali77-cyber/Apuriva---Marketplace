import * as React from 'react';
export interface BadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'style'> {
  tone?: 'neutral' | 'brand' | 'accent' | 'success' | 'warning' | 'error' | 'info';
  /** Lucide name. Semantic tones default to a matching glyph; pass null to force text-only. */
  icon?: string | null;
  size?: 'sm' | 'md';
  solid?: boolean;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}
export declare function Badge(props: BadgeProps): JSX.Element;
