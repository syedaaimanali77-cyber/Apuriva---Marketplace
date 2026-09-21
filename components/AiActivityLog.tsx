// Spec 034 §5: a thin re-export of the design system's existing `ui/components/ai/AiActivityLog`, exactly as
// `components/StatBlock.tsx` does. Ask Apuriva is its first app consumer; no parallel AI primitive exists.
export { AiActivityLog } from '@/ui/components/ai/AiActivityLog';
export type { AiActivityLogProps, AiActivityGroup, AiActivityEntry } from '@/ui/components/ai/AiActivityLog';
