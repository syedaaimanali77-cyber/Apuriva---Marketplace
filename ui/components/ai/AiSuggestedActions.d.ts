import * as React from 'react';
export interface SuggestedAction { label: string; icon?: string; id?: string }
export interface AiSuggestedActionsProps {
  label?: React.ReactNode;
  actions?: Array<SuggestedAction | string>;
  onSelect?: (action: SuggestedAction) => void;
  style?: React.CSSProperties;
}
export declare function AiSuggestedActions(props: AiSuggestedActionsProps): JSX.Element;
