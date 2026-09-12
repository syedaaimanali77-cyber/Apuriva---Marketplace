import React from 'react';
import { iconPaths } from './icon-paths.js';

const SIZES = { xs: 14, sm: 16, md: 20, lg: 24, xl: 32 };

/**
 * Lucide glyph rendered inline. Decorative by default (aria-hidden); pass `title` to expose it
 * to assistive tech. Never use an icon alone to convey status — pair it with text.
 */
export function Icon({ name, size = 'md', color = 'currentColor', strokeWidth = 1.75, title, style, ...rest }) {
  const px = typeof size === 'number' ? size : SIZES[size] || SIZES.md;
  const body = iconPaths[name];
  if (!body) return null;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={px} height={px}
      fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}
      style={{ flexShrink: 0, display: 'block', ...style }}
      dangerouslySetInnerHTML={{ __html: body }} {...rest}
    />
  );
}
