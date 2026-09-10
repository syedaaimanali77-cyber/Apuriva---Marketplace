'use client';

import Link from 'next/link';
import { Icon } from '@/components';
import type { NavItem } from './nav-items';
import styles from './nav-shell.module.css';

export interface SideNavProps {
  items: NavItem[];
  activeId?: string;
}

/** Spec 014 §5 desktop primary navigation — same item set as `BottomTabBar`, adapted layout. */
export function SideNav({ items, activeId }: SideNavProps) {
  return (
    <nav aria-label="Primary" className={styles.sideNav}>
      {items.map((item) => {
        const on = item.id === activeId;
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={on ? 'page' : undefined}
            data-active={on}
            className={styles.sideItem}
          >
            <Icon name={item.icon} size="sm" strokeWidth={on ? 2.1 : 1.75} />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
