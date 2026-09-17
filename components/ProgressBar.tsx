/**
 * Spec 027 §5: a thin re-export of the design system's existing `ui/components/feedback/ProgressBar`,
 * the same way `Skeleton`/`Table` are. Deliberately NOT added to the `@/components` barrel — that
 * file carries uncommitted in-flight design-system work, so this spec's component imports it by path
 * and leaves the barrel alone.
 */
export { ProgressBar } from '@/ui/components/feedback/ProgressBar';
export type { ProgressBarProps } from '@/ui/components/feedback/ProgressBar';
