import React from 'react';
import { Icon } from '../core/Icon.jsx';

export function AiMessage({ role = 'assistant', children, timestamp, pending = false, style }) {
  const user = role === 'user';
  return (
    <div style={{ display: 'flex', gap: 10, justifyContent: user ? 'flex-end' : 'flex-start', ...style }}>
      {!user ? (
        <span aria-hidden="true" style={{ width: 28, height: 28, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 'var(--radius-circle)', background: 'var(--ai-surface)', border: '1px solid var(--ai-border)' }}>
          <Icon name="sparkles" size={15} color="var(--ai-accent)" />
        </span>
      ) : null}
      <div style={{ maxWidth: '78%', display: 'grid', gap: 4, justifyItems: user ? 'end' : 'start' }}>
        <div style={{
          padding: '10px 14px', borderRadius: 'var(--radius-lg)',
          borderStartStartRadius: user ? 'var(--radius-lg)' : 'var(--radius-xs)',
          borderStartEndRadius: user ? 'var(--radius-xs)' : 'var(--radius-lg)',
          background: user ? 'var(--ai-bubble-user)' : 'var(--ai-bubble-assistant)',
          color: user ? 'var(--ai-bubble-user-fg)' : 'var(--text-body)',
          border: user ? 'none' : '1px solid var(--border-subtle)',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', lineHeight: 'var(--leading-normal)',
        }}>
          {pending ? (
            <span aria-label="Ask Apuriva is thinking" style={{ display: 'inline-flex', gap: 4 }}>
              {[0, 1, 2].map((i) => <span key={i} style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--gray-400)', animation: `apr-dot 1.1s ${i * 0.15}s infinite ease-in-out` }} />)}
            </span>
          ) : children}
        </div>
        {timestamp ? <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-subtle)' }}>{timestamp}</span> : null}
      </div>
      <style>{'@keyframes apr-dot{0%,80%,100%{opacity:.3}40%{opacity:1}}'}</style>
    </div>
  );
}
