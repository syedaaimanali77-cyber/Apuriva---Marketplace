'use client';

import { useSelectedLayoutSegment } from 'next/navigation';
import { JsonLd } from './JsonLd';

/**
 * Spec 044 §3.9 — a layout's JSON-LD rendered only on the layout's OWN page, not on the child pages it also
 * wraps (the category layout wraps every service page, which carries its own complete breadcrumb trail).
 * Still server-rendered into the initial HTML, where crawlers read it.
 */
export function LeafJsonLd({ data }: { data: readonly Record<string, unknown>[] }) {
  return useSelectedLayoutSegment() === null ? <JsonLd data={data} /> : null;
}
