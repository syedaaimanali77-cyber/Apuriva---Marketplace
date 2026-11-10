import React from 'react';

const ELEVATION = { flat: 'var(--shadow-none)', subtle: 'var(--shadow-sm)', raised: 'var(--shadow-md)', overlay: 'var(--shadow-lg)' };

export function Card({
  elevation = 'subtle', emphasis = 'none', padding, interactive = false, as = 'div',
  children, style, onClick, ...rest
}) {
  const [hover, setHover] = React.useState(false);
  const Comp = as;
  const emphasised = emphasis === 'brand' || emphasis === 'accent';
  return (
    <Comp
      onClick={onClick}
      onMouseEnter={interactive ? () => setHover(true) : undefined}
      onMouseLeave={interactive ? () => setHover(false) : undefined}
      tabIndex={interactive && !onClick ? undefined : interactive ? 0 : undefined}
      style={{
        background: 'var(--surface-card)',
        border: `1px solid ${emphasis === 'brand' ? 'var(--border-brand)' : emphasis === 'accent' ? 'var(--amber-400)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: padding === undefined ? 'var(--density-card-pad)' : padding,
        boxShadow: hover && interactive ? 'var(--shadow-md)' : ELEVATION[elevation],
        transform: hover && interactive ? 'translateY(-1px)' : 'none',
        transition: 'box-shadow var(--duration-normal) var(--ease-standard), transform var(--duration-normal) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)',
        cursor: interactive ? 'pointer' : undefined,
        ...(emphasised ? { boxShadow: `inset 0 0 0 1px ${emphasis === 'brand' ? 'var(--teal-100)' : 'var(--amber-100)'}` } : null),
        ...style,
      }}
      {...rest}
    >
      {children}
    </Comp>
  );
}
