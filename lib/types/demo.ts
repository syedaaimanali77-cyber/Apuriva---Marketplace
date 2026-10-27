/** Spec 045 §3.2 — demo mode request types. D1 and D2 return the existing `SessionDto` (lib/types/auth.ts). */

/** The two personas a visitor can try. There is no admin persona (spec 045 D-2: admin MFA is mandatory). */
export const DEMO_PERSONAS = ['customer', 'provider'] as const;

export type DemoPersona = (typeof DEMO_PERSONAS)[number];

export interface DemoLoginRequest {
  persona: DemoPersona;
}
