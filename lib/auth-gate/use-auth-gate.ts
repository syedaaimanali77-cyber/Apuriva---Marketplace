'use client';

import { usePathname, useRouter } from 'next/navigation';
import { saveResumeState } from './resume-state';

export interface AuthGateOptions {
  /** Label for the action being protected, e.g. "save-provider" — read back by the destination
   * page via `useResumedAction` once the guest returns authenticated. */
  actionType: string;
  /** Non-sensitive data needed to replay the action after resuming — never a secret (enforced by
   * `saveResumeState`). */
  payload?: Record<string, unknown>;
  /** Where to send the guest to authenticate. Defaults to the existing spec 005 login page. */
  loginPath?: string;
}

export interface AuthGateResult {
  /** `true` if this call was intercepted as a guest hitting an identity-required action —
   * the caller should stop (the guest is being redirected) rather than continue as if it succeeded. */
  redirectedToAuth: boolean;
  response: Response;
}

/**
 * Spec 007 AC-3/§4 — wraps a call to an identity-requiring endpoint. If the server rejects it
 * with `401 UNAUTHENTICATED` (the guest-needs-to-authenticate case specifically — not e.g. spec
 * 005's `401 MFA_REQUIRED`, which is a different, already-authenticated scenario the caller
 * should keep handling itself), this saves the in-progress action as AuthGate resume state and
 * redirects to login. Callers should still branch on `res.ok`/status themselves for every other
 * outcome; `useAuthGate` only intercepts this one specific case.
 */
export function useAuthGate() {
  const router = useRouter();
  const pathname = usePathname();

  async function guard(options: AuthGateOptions, run: () => Promise<Response>): Promise<AuthGateResult> {
    const response = await run();

    if (response.status === 401) {
      let code: string | undefined;
      try {
        code = (await response.clone().json())?.code;
      } catch {
        code = undefined;
      }

      if (code === 'UNAUTHENTICATED') {
        saveResumeState({ returnTo: pathname, actionType: options.actionType, payload: options.payload });
        router.push(options.loginPath ?? '/login');
        return { redirectedToAuth: true, response };
      }
    }

    return { redirectedToAuth: false, response };
  }

  return { guard };
}
