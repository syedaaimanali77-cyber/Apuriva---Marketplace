/** Spec 037 §5 — the "As of" label: the server's `generatedAt`, shown in the viewer's locale. */
export function formatAsOf(iso: string): string {
  return new Date(iso).toLocaleString();
}
