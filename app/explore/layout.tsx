import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getRequestLocale } from '@/lib/i18n/server';
import { exploreSeo } from '@/lib/seo/catalog-metadata';

/**
 * Spec 044 §3.9 (AC-5) — `/explore`'s search metadata. The explore pages are client components and are
 * not modified; this server layout only contributes metadata. Deeper segments override it with their own.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { locale } = await getRequestLocale();
  return exploreSeo(locale).metadata;
}

export default function ExploreLayout({ children }: { children: ReactNode }) {
  return children;
}
