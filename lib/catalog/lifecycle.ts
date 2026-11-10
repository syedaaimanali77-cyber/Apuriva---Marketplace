import type { CatalogEntityStatus } from '@/lib/types/catalog';

/** Spec 010 §4 Lifecycle: `draft → published`, `draft → pending_review`,
 * `pending_review → published`, and any of `draft`/`published`/`pending_review` → `retired`.
 * `retired` is terminal — no transition out of it (a later spec may add restoration explicitly). */
const VALID_TRANSITIONS: Record<CatalogEntityStatus, CatalogEntityStatus[]> = {
  draft: ['published', 'pending_review', 'retired'],
  published: ['retired'],
  pending_review: ['published', 'retired'],
  retired: [],
};

export function isValidTransition(from: CatalogEntityStatus, to: CatalogEntityStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}
