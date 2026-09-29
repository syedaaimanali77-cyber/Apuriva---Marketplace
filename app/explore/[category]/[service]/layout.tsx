import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { JsonLd } from '@/app/_components/JsonLd';
import { getRequestLocale } from '@/lib/i18n/server';
import { serviceSeo } from '@/lib/seo/catalog-metadata';

type Params = Promise<{ category: string; service: string }>;

/**
 * Spec 044 §3.9 (AC-5) — a published service's metadata, `BreadcrumbList` and `Service`. The canonical
 * uses the service's own category, whatever category segment the URL carried.
 */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const [{ service }, { locale }] = await Promise.all([params, getRequestLocale()]);
  return (await serviceSeo(locale, service)).metadata;
}

export default async function ServiceLayout({ children, params }: { children: ReactNode; params: Params }) {
  const [{ service }, { locale }] = await Promise.all([params, getRequestLocale()]);
  const { jsonLd } = await serviceSeo(locale, service);
  return (
    <>
      <JsonLd data={jsonLd} />
      {children}
    </>
  );
}
