'use client';

import Link from 'next/link';
import { Icon } from '@/components';
import { useLocale } from '@/app/_components/LocaleProvider';
import type { NavItem } from './nav-items';
import styles from './nav-shell.module.css';

export interface BottomTabBarProps {
  items: NavItem[];
  activeId?: string;
}

/** Spec 014 §5 mobile primary navigation — same item set as `SideNav`, adapted layout. */
export function BottomTabBar({ items, activeId }: BottomTabBarProps) {
  const { t } = useLocale();
  return (
    <nav aria-label={t('chrome.nav.primary')} className={styles.bottomBar}>
      {items.map((item) => {
        const on = item.id === activeId;
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={on ? 'page' : undefined}
            data-active={on}
            className={styles.bottomItem}
          >
            <Icon name={item.icon} size="md" strokeWidth={on ? 2.2 : 1.75} />
            <span className={styles.bottomLabel}>{item.labelKey ? t(item.labelKey) : item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
