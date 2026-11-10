import type { ReactNode } from 'react';
import { noindexMetadata } from '@/lib/seo/route-policy';

/** Spec 044 §3.8 (AC-6) — a private segment: `noindex, nofollow`, no canonical. Renders its pages unchanged. */
export const metadata = noindexMetadata();

export default function NoindexLayout({ children }: { children: ReactNode }) {
  return children;
}
