import { isDemoAvailable } from '@/lib/demo/guards';
import { DemoEntry } from './DemoEntry';

/**
 * Spec 045 §5 — the demo entry point, `/demo`. A server component: whether demo is available is decided here,
 * server-side, by the same §3.1 checks every `/api/v1/demo/*` route runs, so an unavailable environment renders
 * the unavailable state instead of buttons that would only be refused (AC-7).
 *
 * It lives in the `(auth)` route group, so the URL is exactly `/demo` while the page inherits that segment's
 * spec 044 `noindex` layout and the shared auth shell — no new top-level segment, so spec 044's route policy is
 * unchanged.
 */
export default async function DemoPage() {
  return <DemoEntry available={await isDemoAvailable()} />;
}
