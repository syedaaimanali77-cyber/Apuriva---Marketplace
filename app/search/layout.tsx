import type { ReactNode } from 'react';
import { noindexMetadata } from '@/lib/seo/route-policy';

/** Spec 044 §3.8 (AC-6) — `/search`: `noindex, follow` (its result links may be crawled), no canonical. */
export const metadata = noindexMetadata({ follow: true });

export default function SearchLayout({ children }: { children: ReactNode }) {
  return children;
}
