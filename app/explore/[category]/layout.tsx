import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { LeafJsonLd } from '@/app/_components/LeafJsonLd';
import { getRequestLocale } from '@/lib/i18n/server';
import { categorySeo } from '@/lib/seo/catalog-metadata';

type Params = Promise<{ category: string }>;

/**
 * Spec 044 §3.9 (AC-5) — a published category's metadata and `BreadcrumbList`; an unknown or unpublished
 * one is `noindex` with no canonical, while the client page renders its own not-found state.
 */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const [{ category }, { locale }] = await Promise.all([params, getRequestLocale()]);
  return (await categorySeo(locale, category)).metadata;
}

export default async function CategoryLayout({ children, params }: { children: ReactNode; params: Params }) {
  const [{ category }, { locale }] = await Promise.all([params, getRequestLocale()]);
  const { jsonLd } = await categorySeo(locale, category);
  return (
    <>
      <LeafJsonLd data={jsonLd} />
      {children}
    </>
  );
}
