/**
 * Single source of truth for brand strings (master spec §3.1: branding must never leak into
 * business logic as ad hoc hardcoded copy). Every screen, email template, and metadata tag
 * reads from here — changing a value in this file is the only edit required to propagate it.
 */
export const branding = {
  appName: 'APURIVA',
  aiAssistantName: 'Apuriva Assistant',
  tagline: 'Get the right help. Get it done.',
} as const;

export type Branding = typeof branding;
