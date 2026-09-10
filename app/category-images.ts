/**
 * Visual-only mapping from a real category's name (master spec §14's 8 MVP categories) to
 * representative photography (public/images/marketing/, licensed — see CREDITS.md there). This
 * is decorative/representative imagery for the category as a whole, never asserted as a photo of
 * any specific real provider — no such per-provider photo exists in the data model. Falls back to
 * a stable, deterministic pick (by name) for any category name that doesn't match a keyword, so
 * an unrecognized category still gets a real photo rather than a blank tile.
 */
const CATEGORY_IMAGE_BY_KEYWORD: Array<{ keyword: string; src: string }> = [
  { keyword: 'clean', src: '/images/marketing/category-cleaning.jpg' },
  { keyword: 'beauty', src: '/images/marketing/category-beauty-wellness.jpg' },
  { keyword: 'wellness', src: '/images/marketing/category-beauty-wellness.jpg' },
  { keyword: 'photo', src: '/images/marketing/category-photography-video.jpg' },
  { keyword: 'video', src: '/images/marketing/category-photography-video.jpg' },
  { keyword: 'mov', src: '/images/marketing/category-moving-delivery.jpg' },
  { keyword: 'deliver', src: '/images/marketing/category-moving-delivery.jpg' },
  { keyword: 'event', src: '/images/marketing/category-events.jpg' },
  { keyword: 'auto', src: '/images/marketing/category-automotive.jpg' },
  { keyword: 'car', src: '/images/marketing/category-automotive.jpg' },
  { keyword: 'personal', src: '/images/marketing/category-personal-professional.jpg' },
  { keyword: 'professional', src: '/images/marketing/category-personal-professional.jpg' },
  { keyword: 'repair', src: '/images/marketing/category-home-repair.jpg' },
  { keyword: 'maintenance', src: '/images/marketing/category-home-repair.jpg' },
  { keyword: 'home', src: '/images/marketing/category-home-repair.jpg' },
];

const FALLBACK_IMAGES = [
  '/images/marketing/category-home-repair.jpg',
  '/images/marketing/category-cleaning.jpg',
  '/images/marketing/category-beauty-wellness.jpg',
  '/images/marketing/category-automotive.jpg',
  '/images/marketing/category-events.jpg',
  '/images/marketing/category-moving-delivery.jpg',
  '/images/marketing/category-photography-video.jpg',
  '/images/marketing/category-personal-professional.jpg',
];

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function imageForCategoryName(name: string): string {
  const lower = name.toLowerCase();
  const match = CATEGORY_IMAGE_BY_KEYWORD.find((entry) => lower.includes(entry.keyword));
  if (match) return match.src;
  return FALLBACK_IMAGES[hashString(name) % FALLBACK_IMAGES.length]!;
}
