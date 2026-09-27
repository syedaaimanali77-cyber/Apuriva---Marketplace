'use client';

import { Table as DsTable, type TableProps } from '@/ui/components/data/Table';
import { useLocale } from '@/app/_components/LocaleProvider';

export type { TableColumn, TableProps } from '@/ui/components/data/Table';

/** Spec 042 X-2 (§5.2) — the DS `Table` with its `emptyMessage` defaulted from `t()`. */
export function Table<T>({ emptyMessage, ...props }: TableProps<T>) {
  const { t } = useLocale();
  return <DsTable {...props} emptyMessage={emptyMessage ?? t('common.nothingToShow')} />;
}
