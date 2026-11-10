import React from 'react';

export function Skeleton({ width = '100%', height = 16, radius = 'var(--radius-sm)', lines = 1, gap = 8, style }) {
  const bar = (i) => (
    <span key={i} aria-hidden="true" style={{
      display: 'block', width: lines > 1 && i === lines - 1 ? '62%' : width, height,
      borderRadius: radius, background: 'linear-gradient(90deg,var(--gray-100) 25%,var(--gray-200) 37%,var(--gray-100) 63%)',
      backgroundSize: '400% 100%', animation: 'apr-shimmer 1.4s ease infinite',
    }} />
  );
  return (
    <span role="status" aria-live="polite" aria-busy="true" style={{ display: 'grid', gap, ...style }}>
      <span className="apr-visually-hidden">Loading</span>
      {Array.from({ length: lines }, (_, i) => bar(i))}
      <style>{'@keyframes apr-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}@media (prefers-reduced-motion:reduce){[role="status"] span{animation:none!important}}'}</style>
    </span>
  );
}
