import React from 'react';
import { Icon } from '../core/Icon.jsx';

// Adornments sit over the input's own padding, so the <input> itself is the whole field and carries the
// focus ring (spec 043 D-7 checks the focused element). Icon "sm" is 16px; 8px is the adornment gap.
const PAD_X = 12;
const ICON_PX = 16;
const GAP = 8;

export function Input({
  size = 'md', iconLeft, iconRight, prefix, invalid = false, disabled = false,
  fullWidth = true, style, onFocus, onBlur, ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const prefixRef = React.useRef(null);
  const [prefixWidth, setPrefixWidth] = React.useState(0);
  const h = size === 'sm' ? 34 : size === 'lg' ? 48 : 40;
  const border = invalid ? 'var(--field-border-error)' : focus ? 'var(--field-border-focus)' : 'var(--field-border)';

  const hasPrefix = prefix !== undefined && prefix !== null && prefix !== false;
  React.useLayoutEffect(() => {
    const el = prefixRef.current;
    if (!el) return undefined;
    const measure = () => setPrefixWidth(el.offsetWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasPrefix]);

  const hasStart = Boolean(iconLeft) || hasPrefix;
  const startInset = PAD_X + (iconLeft ? ICON_PX + GAP : 0) + (hasPrefix ? prefixWidth + GAP : 0);
  const endInset = PAD_X + (iconRight ? ICON_PX + GAP : 0);
  const adornment = { position: 'absolute', top: 0, bottom: 0, display: 'flex', alignItems: 'center', gap: GAP, pointerEvents: 'none' };

  return (
    <div style={{
      position: 'relative', display: 'flex', alignItems: 'center', height: h, width: fullWidth ? '100%' : undefined,
      background: disabled ? 'var(--field-bg-disabled)' : 'var(--field-bg)',
      border: `1px solid ${border}`, borderRadius: 'var(--radius-md)',
      transition: 'border-color var(--duration-fast) var(--ease-standard)',
      ...style,
    }}>
      <input
        disabled={disabled} aria-invalid={invalid || undefined}
        {...rest}
        onFocus={(e) => { setFocus(true); onFocus && onFocus(e); }}
        onBlur={(e) => { setFocus(false); onBlur && onBlur(e); }}
        style={{
          width: '100%', minWidth: 0, height: '100%', boxSizing: 'border-box',
          paddingBlock: 0, paddingInlineStart: startInset, paddingInlineEnd: endInset,
          border: 'none', outline: 'none', background: 'transparent',
          borderRadius: 'calc(var(--radius-md) - 1px)',
          boxShadow: focus ? (invalid ? 'var(--ring-error)' : 'var(--ring-focus)') : 'none',
          transition: 'box-shadow var(--duration-fast) var(--ease-standard)',
          fontFamily: 'var(--font-sans)', fontSize: size === 'sm' ? 'var(--text-sm)' : 'var(--text-base)',
          color: 'var(--text-heading)',
        }}
      />
      {hasStart ? (
        <span style={{ ...adornment, insetInlineStart: PAD_X }}>
          {iconLeft ? <Icon name={iconLeft} size="sm" color="var(--text-subtle)" /> : null}
          {hasPrefix ? <span ref={prefixRef} style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{prefix}</span> : null}
        </span>
      ) : null}
      {iconRight ? (
        <span style={{ ...adornment, insetInlineEnd: PAD_X }}>
          <Icon name={iconRight} size="sm" color="var(--text-subtle)" />
        </span>
      ) : null}
    </div>
  );
}
